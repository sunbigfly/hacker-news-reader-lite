# Hacker News Reader Lite 架构

## 1. 架构目标

架构服务于一个轻量阅读产品，不服务于论坛管理或全站改造。底层优先复制参考 Lite 的已验证 owner，顶层使用新的 HN 适配器和精简组合根。

五个核心不变量：

1. 没有待恢复帖子且宿主未打开 Reader 时几乎不工作。
2. DOM 和 API 只提交 canonical data，不直接操作投影。
3. 视图只发命令，请求、缓存、树和几何各有唯一 owner。
4. 评论树、译文、总结和离线文档使用相同内容身份，但独立缓存。
5. 每个会话都有明确的 LifecycleScope，可完整清理。

## 2. 系统上下文

```text
HN list/item DOM
      |
      v
HN Host Adapter ---- delegated commands ----> Reader Workspace (Shadow DOM)
      |                                      |
      | DOM bootstrap                        +--> Native external tab
      v                                      |
Thread Session <---- HN API supplement ------+--> Comment Projection
      |                                                   |
      v                                                   +--> Translation
Canonical Comment Tree                                    +--> Discussion Summary
      |                                                   +--> Offline HTML
      v
Branch-aware Virtual Stream
```

## 3. 源码布局

```text
lite/
  src/
    app/             # 精简组合根，不承担业务算法
    kernel/          # 复用：lifecycle、signal、gate
    userscript/      # metadata runtime、GM environment、入口
    host/            # HN route/DOM/click 适配
    hn-api/          # 官方 API descriptor 与 adapter
    network/         # 复用：scheduler/client/request contract
    cache/           # 复用：IndexedDB/repository/identity
    thread/          # StorySession、CommentTree、snapshot、全帖本地预热
    stream/          # 分支感知虚拟投影与帧事务
    shell/           # ShadowRoot、评论 Reader、简化工具栏、焦点
    article/         # 外链 URL 安全策略；提取器仅保留为非运行时实验代码
    translation/     # Google/Microsoft/AI、分段、三态投影
    ai/              # OpenAI-compatible config/completion/cache
    summary/         # 讨论总结
    vocabulary/      # 评论词汇：AI 收集、高亮、悬停词卡、收藏单词本
    offline/         # 单 HTML 序列化与离线 runtime
    settings/        # 极简翻译/AI/外观/清理配置
  styles/            # 按 shell/stream/settings 分层
  tests/             # 单元、合同、fixture 和分包无关构建测试
  fixtures/          # 脱敏 HN DOM/API/文章样本
  userscript.meta.txt
scripts/             # 构建、元数据审计、复用依赖扫描、性能 fixture
work/                # 本地调试生成物
dist/                # 发布生成物
```

### 3.1 响应式工作区

`ReaderWorkspace` 在不超过 900 CSS px 的视口切为全屏 Reader，宿主页保持完整宽度。Reader 挂在 `body` 内，只对背景宿主子节点设置 inert，不对整个 `body` 设置 inert，使移动 WebView 的触控事件路径仍经过 `body`；若宿主原本已设置 body inert，则保留其状态并将 Reader 挂在 `html` 下。关闭、切换宽屏或返回原生表单时恢复背景节点原有属性；关闭时还恢复样式和滚动位置。媒体查询监听器只在工作区生命周期内存在，恢复宽屏时重新应用保存的分栏比例，不因响应式切换写入设置。触控软键盘导致 visual viewport 改变时，窗口尺寸更新合并到一帧；双指缩放时保留浏览器视口行为。

小屏导航到原生 reply/submit 时隐藏 Reader 浮层并显示返回入口，保留会话、树状态和位置；显式打开讨论或点击返回入口重新显示 Reader。桌面仍沿用 ADR-0008 的表单分栏。`ReaderView` 使用可点击工具按钮和明确的展开状态，关闭按钮独立于折叠工具区；小屏树缩进由 CSS 限制，canonical depth 与操作身份不变。

## 4. 领域模型

### 4.1 标识

- `StoryId`：HN 故事 item ID。
- `CommentId`：HN 评论 item ID。
- 两者都是正安全整数，通过独立构造器校验，不用楼层号代替。
- `CommentRank`：该评论在父 item `kids` 中的索引；用于保留 HN 排序。

### 4.2 Canonical Comment

```text
Comment {
  id, storyId, parentId, childIds, rank,
  author, createdAt, html,
  deleted, dead,
  source: dom | api | cache,
  observedAt
}
```

DOM 初始快照允许 `childIds` 不完整；API 补全不得重排已知 `kids`。同一 item 的新值由 `observedAt + source precedence` 决定是否替换，不由视图决定。

### 4.3 ThreadSnapshot

```text
ThreadSnapshot {
  schemaVersion, story, comments,
  loadedIds, missingIds,
  complete, capturedAt
}
```

`complete` 只在官方 Story `descendants`/实际遍历和删除/dead 语义能合理对齐时成立。离线下载和 AI 总结必须显示该状态。

## 5. 数据获取

### 5.1 DOM-first

- userscript 在 `document-start` 先安装路由对应的宿主皮肤并隐藏未投影的 body；`DOMContentLoaded` 后一次性标记宿主 DOM、解除隐藏并安装列表委托事件。不安装 MutationObserver。
- 宿主 capture 导航只接受顶部 tab 路径和 Reader 显式发起的 `/reply`；tab 结果进入有上限的会话内 LRU，重访时先同步命中缓存，再在同一 scheduler 上后台重新验证。导航替代在途请求时，scheduler 立即从去重表移除已取消条目；同 key 的快速重试必须创建新请求。`item?id=*` 在 capture 阶段改发 Reader；故事 ID 直接打开，评论 ID 经官方 API `parent` 链有界解析到所属故事后定位。它不替换宿主内容、不写宿主 history；直接从 `item` URL 启动时，当前 DOM 先交给 Reader，左侧再静默投影默认 `news` tab 且保留当前地址。
- 宿主列表仅在用户滚动进入底部阈值后，经 `HnListPageAdapter` 匿名获取当前 More URL；无定时预取或轮询。
- 打开 Reader 时先同步使用列表故事行挂载空评论 Shell；评论 DOM 可用后首批最多解析 48 条，至少交出一帧，再按顺序与缩进栈构建完整 parent/rank。缓存恢复也先验证并投影 48 条，再在首帧后验证全量快照。
- 适配器通过 fixture 合同固定实际 HN 标记；选择器不泄漏到领域层。
- 不为等待未知动态 DOM 安装长驻 MutationObserver。

### 5.2 API supplement

- 唯一 API 基址：`https://hacker-news.firebaseio.com/v0/`。
- 只允许登记的 `item/{id}.json` descriptor，视图不传入任意 URL。
- 中央 scheduler 默认总并发 4，可见/交互请求优先，补全可丢弃，同 item 去重。
- 打开 Reader 不做全树 API 遍历。缺失分支、手动刷新或过期快照检查仍走补全请求。
- 完整页面快照挂载后，ReaderScope 建立一条官方 `/updates.json` SSE。只对当前 StoryId 或 canonical tree 中已知父评论的变更做响应：先获取变更父 item，再经同一 scheduler 仅补新增子树。不订阅每条评论，不重抓整帖。
- 无定时轮询；由于 HN 页面 CSP 禁止跨域 `EventSource`，SSE 经 userscript `GM_xmlhttpRequest` 流式边界连接，断线按 1/2/4/8 秒退避并封顶 30 秒，ReaderScope 销毁时关闭。

## 6. 评论树与虚拟投影

### 6.1 Canonical tree

`CommentTree` 是父子关系的唯一 owner，复用参考 `ReplyTreeTopology` 的事务 commit、环检测和派生缓存。DOM、API、cache 都只提交 Comment input。

### 6.2 Visible projection

`CommentProjection` 根据：

- HN `kids` 顺序；
- 分支折叠状态；
- 已加载/缺失状态；
- 定位时的必要祖先；

生成线性 visible entries。折叠不删 canonical data。

在线 projection 另持有 `replyWindows`（commentId → 手动展开的直接子项数，0 表示只收起回复），与原有隐藏整条评论的 collapsed 集合分离。默认智能策略按后代已知数量 >10 或深度达到 2 层收起回复；全部展开/仅主评论及阈值、层数、每批数量来自设置。后代数量每次投影通过一次 memoized 树遍历派生，缺失节点使数量标记为下界。

未显示子项由独立 `replies` entry 承载，每次开放 20 个直接子项；其身份使用第一个隐藏子项，展开后延续同一滚动锚点。父正文保留，隐藏子项不进入可见投影或 DOM。手动窗口随 Topic 状态持久化；旧记录无该字段时使用默认规则。定位增大沿途窗口以包含目标，不展开无关深分支。展开仅经现有 API adapter/scheduler 获取本批缺失单项，去重并随 ReaderScope 取消，不递归请求整棵树。离线 runtime 继续沿用独立的已有折叠行为。

### 6.3 Branch-aware window

参考 Lite 虚拟流的根窗口需改造为可见 entry 窗口，因为 HN 可能有一个包含数百回复的根分支。

- DOM 挂载上限默认 120。
- 物理可见集与 overscan 集分开；overscan 每个方向至少一个当前视口高度，顶部打开时一次挂载不少于两屏正文，并受 120 条 DOM 上限保护。
- 未挂载段使用 spacer，实测高度累积到 prefix layout。
- ResizeObserver 回调只记录，rAF 中最多一次 scroll compensation 和一次 DOM commit。
- 用户滚动时可延后非必要测量，停止后合并处理。
- 分支线使用 CSS border/pseudo-element，不安装持续 SVG 几何系统。

### 6.4 全帖本地预热

`ThreadPreheater` 只在 Reader 已完成首屏挂载后启动。每个空闲分片最多处理 32 条且主动限制在 8 ms 内，预计算规范化搜索文本、翻译保护分段、内容指纹、深度/子节点索引和估算高度。结果按 CommentId 保存，虚拟流用估算高度预置 prefix layout，翻译复用已分段文本。

预热没有网络端口，不初始化翻译或 AI provider；API 手动补全后仅重启本地增量扫描。ReaderScope 销毁会取消待执行 idle callback 并清空索引。

## 7. 用户界面

### 7.0 宿主列表与评论页

- `HnHostController` 在现有 HN 行对上增加可逆数据标记，由独立宿主样式将故事与元信息投影为卡片；不复制、重排或持久化列表数据。
- `/newcomments` 与 `/threads` 使用独立路由类和同一可逆标记机制，将原生 `tr.athing[id]` 投影为评论卡片并收起 spacer；正文 DOM 继续由 HN 拥有，卡片空白区以及时间、parent、context、原帖等 HN `item` 链接打开该评论所属故事的 Reader，投票、作者与外站链接保持原生。
- 顶部 HN 导航的 DOM 和账号仍由宿主拥有；Reader 关闭时顶部 tab 保持原生跳转，Reader 打开时只有这些 tab 和 `/reply` 可在左侧宿主内静默替换。裸 `threads` 地址先从宿主账号链接补全用户名；故事卡片、原生评论数链接和其他 `item?id=*` 统一打开 Reader，不变更当前宿主 tab 或 URL。投票、hide、登出等写操作、modified 点击、外站链接和显式新标签仍保留原生语义。
- 卡片通过单一列表级 `click`/`keydown` 委托打开 Reader；无 modifier 的主键空白区/标题点击和卡片 Enter/Space 进入 Reader。Modified 标题点击、其他链接/按钮/表单控件与文本选区保留原语义。
- 翻译总开关开启时，`HostTitleTranslator` 把当前页标题作为一个交互批次交给 `TranslationService`，与评论翻译共用 provider 设置和 30 天文本指纹缓存；卡片不显示独立翻译命令。
- `HnListPaginationController` 同时监听全页和分栏宿主滚动容器，从 document 捕获动态滚动目标，并用 More 可见性哨兵兜底；同一滚动事件批次只做一次底部距离判断。More、Reader 评论页与宿主 tab 共享同一个总并发为 2 的 HN HTML scheduler；一个 Reader 恢复刷新在途时，宿主 tab 交互仍能立即开始，More 则使用更低的 supplement 优先级。分页通过页面原生 `fetch` 只向已校验的 HN 同源地址携带当前宿主会话；同 URL 仍去重，首次失败仅自动重试一次，随后保留原生 More。新行由 `HnHostController` 导入后复用卡片、Reader 点击和标题翻译合同。
- More 所在行在成功后被下一页 More 替换，Footer 不复制，始终位于 itemlist 之后；持续失败时 More 显示简短错误提示，手动点击仍只在左侧宿主内换页。
- 宿主样式与标记归 `HostScope` 所有；销毁时恢复先前的 class、attribute、外链属性与 DOM 命令。

### 7.1 评论 Reader

- `ReaderWorkspace` 默认按 48% HN 宿主 + 52% Reader 锚定；左缘 `separator` 可用鼠标拖动或方向键调整，Reader 比例限制为 32%..90%，宿主最窄 10% 且表单/文本必须在面板内折行收缩；只在交互提交时写入 GM Storage，后续会话恢复。
- HN 原生 `#hnmain[width="85%"]`、`#hnmain { min-width: 796px }` 以及父级 `<center>` 都属于工作区几何输入。打开时逐项快照并用内联 `!important` 归一化 `html > body > center > #hnmain`；Reader 根节点直接作为 `html` 子节点固定到右侧，避免相对已压缩宿主再次计算百分比。
- 列表和 Reader 各自滚动，滚动条统一为 5 px 灰色窄轨。分栏时宿主 `<center>` 作为从冻结标题下方开始的独立滚动容器，标题行固定在宿主顶部；scope 销毁时按逆序恢复几何与滚动位置。
- Reader 成功挂载帖子时立即记录 StoryId；Reader 关闭时在用户名左侧提供恢复入口，点击后通过同一 `HnPageFetchAdapter` DOM-first 主链打开该帖子，并高亮、滚动显露宿主列表中对应的故事卡片；Reader 打开期间隐藏入口。当前 URL 是 `item?id=*` 时仍直接打开该 item 目标，不引入轮询。
- 列表页通过 `HnPageFetchAdapter` 匿名获取所选宿主评论页，在脱离 DOM 中解析；`item` 页则直接复用当前 DOM，两者都不改写 HN 原生评论表。
- 用户点击后立即从列表行挂载 Reader Shell；30 天本地 Thread 快照命中时先验证/投影最多 48 条，首帧后展开全量快照，并经同一 `HnPageFetchAdapter` 后台更新 canonical tree。冷路径在评论页返回后也先显示 48 条再接入全树。列表空闲时不预抓取；只有标题翻译开关或用户滚动进入 More 阈值才产生对应请求。
- 回复层级按参考阅读器的 segmented branch 规则投影：父楼正文下接主干，子楼只画自己的线段与弯头，canonical 末子节点在弯头收尾。
- 顶部只显示原标题、自动翻译开启时的中文译题副标题、覆盖状态、翻译、总结、离线、外链新标签和关闭；所有故事列表的译题副标题与评论流译文复用同一 `TranslationService`、当前设置中的翻译服务/模型/提示词和文本指纹缓存，失败时不替换原文。宿主只同步评论正文字体排版，不接入 Reader 的七种译文呈现样式。
- Reader 回复命令只在左侧载入 HN 原生回复表单并提供返回讨论入口；表单提交、投票及其他写操作仍由 HN 原生处理，不创建二次互动实现。

### 7.2 外链新标签

- HN 外部标题保留原始 URL；modified 标题点击使用 `_blank` 与 `noopener noreferrer`。
- Reader 的文章命令经 URL 策略校验后调用浏览器原生新标签；不创建浮窗、不抓取正文。

### 7.3 设置

一个极简弹层，仅包含：

- 翻译显示模式与服务选择；
- AI base URL / API key / model / prompt / 配额；
- Reader 标题与评论正文各自使用可搜索字体选择器：用户进入字体面板时通过浏览器 Local Font Access 能力自动读取字体家族、去重并将常见中文字体优先以中文名称展示；无能力或未授权时保留手动字体名称降级。两处选择均即时预览并统一保存；同一面板提供默认开启的 Reader 内置字体显示优化开关，按 Blink/Gecko/WebKit 应用平滑、描边与阴影参数，并排除代码块与图标；
- 正文字重、字号、行高和明暗主题；底部主题选择通过单一宿主主题 port 同步投影到 HN 与 Reader，显式浅色/深色覆盖系统偏好，“跟随系统”由媒体查询响应；
- 清理缓存和重置。

不提供按类别的管理中心。

## 8. 翻译与 AI

### 8.1 翻译

- `TranslationSegmenter` 把评论 DOM 转为按正文顺序排列的可翻译段和受保护 token。
- 每个段落保留独立身份、缓存与回填位置；自定义 AI 把同一优先级批次中的多条评论按段落轮转排列，在 8,000 字符预算内跨评论合包，超出后形成下一包。公共翻译保留每包最多 6 段及 URL/请求体边界。AI SSE 每产生一段局部译文就重绘该段，不等待同包其他段落或整条评论完成。
- 未收到译文的段落显示可视化骨架占位，正在接收 SSE 的段落显示流式光标；减少动效偏好会关闭这些动画。
- 宿主标题/评论和 Reader 共用页面级唯一 `TranslationRuntime`。`TranslationTaskManager` 保留 interactive > visible > prefetch 优先级，后台预取最多占 5 个 worker，第 6 个 worker 为新进入视野的正文保留；同一稳定包进入视野时原地晋级并复用在途请求。队列独立于 HN/API，仍受每个 AI 服务的 RPM/TPM 配额约束。
- 滚动和译文高度变化只向统一队列增量追加新段落，不取消、不重建已在途请求；只有关闭页面、关闭翻译或显式替换配置才能取消已失去意义的任务。
- 翻译操作显式请求无推理模式，避免简单译文在首 token 前停顿；不影响 AI 讨论总结。可恢复错误独立重试，最终失败必须把骨架收口为明确的可重试状态。
- 公共服务默认 Google -> Microsoft；当单段超长时 Microsoft -> Google。
- 公共服务全部失败后不自动调用 AI。
- 自定义 AI 使用用户显式选择的 Profile。

### 8.2 AI Completion

- 只允许经校验 base URL 下的 `/models` 和 `/chat/completions`。
- 每个 base URL + model 独立计算 RPM/TPM；0 表示不额外限制。
- 密钥不进入业务配置导出、缓存 key 或诊断。

### 8.3 总结

- 讨论总结使用树感知 JSON，保留 item ID、父子关系、作者和文本。
- 全帖与分支总结使用不同 scope identity，不串用缓存。

### 8.4 评论词汇

- 用户显式开启后才工作；开启即代表同意把进入视野的评论原文交给已配置 AI。
- `VocabularyService` 是唯一请求入口：词汇身份 = 提示词版本 + 难度下限 + base URL + 模型 + 评论正文指纹，命中缓存直接返回，空结果缓存 60 秒。
- 请求复用 `TranslationRuntime` 的 scheduler 与 `TranslationTaskManager`，因此并发、RPM/TPM、同 key 去重和 `interactive > visible > prefetch` 优先级与翻译共用一套；词汇不进翻译缓存，翻译也不进词汇缓存。
- 只有 `ReaderView` 挂载并进入视野的评论才收集；`ReaderScope` 销毁会取消在途任务，关闭开关只清 DOM 与高亮、保留缓存。
- 词汇按词筛选、示例与例句译文都由模型给出；`vocabulary/model.ts` 只接受原文中确实出现过、释义为中文、例句带译文的条目。
- 高亮在评论原文的文本节点上插入 `<mark>`，停用时逐节点还原，不新增 MutationObserver、不轮询。
- 笔刷不用 `data:` 背景图，而是内联 `<svg>` 子元素：HN 的 CSP 为 `img-src 'self' https://account.ycombinator.com`，任何 `data:` 图片都会被拒绝，参考实现的笔刷在宿主上永远画不出来。内联 SVG 属于 DOM 而不是待加载图片，因此不受该策略限制；`mark` 用 `isolation: isolate` 建立层叠上下文，负 z-index 的笔刷画在文字之下。高亮**只有这一层笔画**：不加深色底纹、不加下划线，因为浏览器自带的 `mark` 黄色底纹与另加的一层底色条都会在笔画之上再叠一层，看起来像被框住。`background-color: transparent; text-decoration: none; padding: 0` 这条中和规则仍必须存在（UA 的 `mark` 自带黄底），并按 301 优先级覆盖四种正文副本。
- 跨行的 `mark` 由样式表画：一个 mark 换行后每行各有一个盒子，而笔刷是**单个**绝对定位子元素，只能贴在其中一行后面，中文片段几乎随处可折行，所以换行的 mark 会被打上 `data-vocabulary-wrap` 标记并改用**每片段背景**（两条 `linear-gradient`，强度沿用参考的两笔 24% / 14%，两端渐隐模拟落笔收笔），`box-decoration-break: clone` 正是参考脚本用于让背景铺到每个片段的设置。渐变不是待抓取的图片，因此不受封禁 `data:` 的 CSP 限制。换行与否只在 mark 落入文档后测量（`getClientRects().length > 1`），所以上墨顺序是"先插入、后上墨"。
- 高亮目标不是固定的 `.hnr-original-text`，而是"当前可见的那份正文"，且只要可见就两种语言都要标：原文模式标 `.hnr-original-text`；双语模式标译文渲染时生成的**每段** original section（英文，标单词本身）与 translation section（中文，标该词释义在译文里对应的片段），同一词在两处使用同一墨色与同一词卡；纯译文模式标 `.hnr-translated-text`。因此每次译文落地或切换显示模式都重新解析目标并重新上墨。
- 中文匹配优先用模型摘录的原样片段：词汇请求在译文可用时把它一并交给模型（模型转述、翻译、编造一律丢弃：片段必须满足 2–12 个汉字且逐字出现在该译文里），因此「the digital equivalent of Morty」→「数字版莫蒂」这类释义与译文措辞完全不重合的情况也能标中。译文替换后片段不再存在、或答案生成于译文到达之前时，回退到 `vocabulary/gloss.ts` 的候选匹配：先取释义中 2 字以上的汉字串（去掉括号说明），再只认**锚定在该短语边界**上、且在译文中**最早出现**的片段，每词最多标 1 处；两者都取不到就不标，绝不写错。
- 词汇与翻译**能合并就合并成一次 AI 请求**（提示词版本 v3 的 `vocabularyCombinedInstruction`）：开启词汇、该评论本来就要翻译且还没有译文时，词汇收集不单独发请求，而是把这些评论登记为"等待合并"（`#vocabularyCombined`）；翻译请求在 `wordsFor` 里点名它们、每段带上 `comment` id，回答除 `section_*` 外再给一个按评论 id 组织的 `words` 对象。翻译服务只搬运这段指令并回传原始词表（`TranslationVocabularyRequest`），词表校验、缓存与绑定仍归词汇 owner（`VocabularyService.publish` 用同一个缓存键写入，所以之后即便有独立请求也会命中缓存）。只有 AI provider 能携带（公共翻译接口做不到）；视野外的、已有译文的评论仍走独立请求。
- 合并回答里的词**先暂存后落地**：模型先流式吐 `section_*`，词表到达时那句中文还没定型，所以 `#combinedWords` 先收着，等该评论译文完成（`translationRecords().has`）才用这份中文校验片段、写缓存并上墨。`#settleVocabularyAfterTranslation` 兜底三种情况——批次没点名这条评论、模型没给这条评论的词、以及"先有词表后有译文"需要重收集一次（`#vocabularyTranslated` 限一次）；翻译批次结束仍未落地的由 `#settleStagedVocabulary` 收尾，宁可退化成没有中文片段的词表，也不丢词。
- 词汇身份包含译文：提示词版本 v3、难度、模型之外，缓存键还含译文指纹，所以"没有译文时得到的词表"和"带译文得到的词表"是两份缓存。独立请求只在译文**已完成**时才把它作为输入（加载/失败占位文案绝不作为译文引用）；绑定身份也包含中文片段，否则"同样的词、新的译文片段"会被当成未变化而保留旧墨迹。
- 标记按子树拼接后的文本匹配，并把每个文本节点一次重建：一个跨内联元素（或跨"还原后残留的节点边界"）的片段会拆成每元素一个 `<mark>`，视觉上是同一段墨迹；`clear()` 在还原每个词之后对根做一次 `normalize()`，使文本合回原来的节点形状，既保证还原 `innerHTML` 不变，也让后续按更长片段匹配仍然可行。
- 单词卡**不得覆盖它自己的词**：卡片优先放在词下方，放不下才翻到词上方（按词的**上边**退让，不是下边），两侧都放不下时取空间较大的一侧并把卡片高度压到该空间内（超出部分卡片内部滚动）。这条不是审美问题：卡片一旦压在词上，指针就落进卡片、词失去 hover、卡片立即收起，于是"展开—收起"以指针为节拍反复闪动。悬停**先驻留 500ms 再展开**：读一条评论时指针会扫过大量高亮词，一碰就弹卡片会把正文压得没法看；键盘 `focus` 不等待。离开词只是预约关闭（180ms 宽限期，进入卡片即取消），所以成对元素不会互相踩踏；卡片内部的滚动不触发关闭（`composedPath` 命中卡片即忽略），页面滚动仍然关闭。卡片自然高度只在打开时测量一次，避免"压高 → 变矮 → 换边 → 变高"的抖动。
- 这套词卡时序由 `bindWordCard` **一处实现、两处使用**：评论里的高亮词与词汇区每行单词都走同一条路径（桌面驻留、宽限期、键盘直开、进入卡片即续命），所以同一个词在正文里和在词表里手感一致；触屏或笔这类无悬停指针改为点按固定卡片，再次点按、点外部、滚动或 Escape 关闭。点按事件在高亮词处消费，不能穿透到包裹它的原链接；两处只在"如何造卡片"上不同。
- 单词本存 GM Storage（`hn-reader:wordbook:v1`，上限 500 词），只做收藏与查看，不做间隔重复；"恢复默认设置"不删除已收藏单词。
- 工作台"单词本"页是两级结构：一级为可响应式分栏的学习卡片列表（搜索/排序/分页），每张卡集中展示单词、音标、释义、收藏日期、难度、记忆例句与独立的朗读/移除操作；二级为词条详情，详情替换列表而不是堆叠在下方。详情默认打开"词典释义"，同屏组合离线英汉（ECDICT）与英文详解（Wiktionary），相邻标签提供双语例句（Tatoeba）和收藏例句；在线结果显示词性、多条释义、例句、来源 ID、贡献者及许可等接口已返回的信息，每个来源各自持有 slot，任一来源失败都不会清空其它来源。
- `WordLookupService` 是词条详情的唯一请求入口，与 `VocabularyService` 分离：它只读取公开词典，不发送用户内容，走同一 `HttpClient` 与 scheduler，descriptor 为 `lane: translation`、`anonymous: true`，每来源 8 秒上限，结果只存会话内存（空结果 24 小时内不重复请求）。
- `vocabulary/ecdict.ts` 的 ECDICT 快照以 base64 gzip 内联，首次打开词条时才用 `DecompressionStream` 解压，不在启动时解析。
- 词条详情不新增 `@grant`/`@connect`：Wiktionary REST 与 Tatoeba 复用现有请求权限。

## 9. 外链导航

1. 用户显式命令后，验证 URL 为公开 HTTP(S)，不含 userinfo，非 localhost、非私网/保留 IP。
2. 使用浏览器原生 `_blank` 打开，并设置 `noopener noreferrer`。
3. userscript 不获取、提取、缓存或嵌入文章正文。

## 10. 离线文档

- 下载命令先复用已缓存译文，再经同一 `TranslationService` 以交互优先级补齐当前 ThreadSnapshot 的全部可翻译评论；翻译失败时不序列化残缺文件。
- 输入是当前 ThreadSnapshot、已补齐的译文、讨论总结，以及脱敏后的标题/正文字体和正文字号设置；不传入完整设置或 AI Key。
- 输出是单 HTML，CSS、精简 runtime 与数据均内联；离线 CSS 通过与在线 Reader 相同的字体栈和字号变量投影标题/评论正文字体与评论正文字号。
- 离线 runtime 支持搜索、分支折叠、原文/双语/译文切换和 item 锚点。
- 讨论总结、总结历史、下载进度、可单条删除的下载历史与可搜索 Topic 浏览历史复用同一个非模态阅读工作台浮窗；下载进度只投影当前任务，不建设后台队列，浮窗正文禁止无意义横向溢出。外层空白点击与文档级 Escape 共享关闭路径并恢复触发入口焦点，内部点击不得误关闭。
- 已完成 HTML 以独立 artifact 记录保存，轻量全局索引只保存元数据；同内容去重，最多保留 20 份、默认 30 天。下载与再次下载都创建短生命周期 Blob 并及时 revoke Object URL。

## 11. 缓存与身份

| 域 | identity | 默认保留 |
| --- | --- | --- |
| Thread | storyId + schema | 30 天 |
| HN item | itemId + observed version | 30 天 |
| Translation | provider/model + target + segment fingerprint | 30 天 |
| Discussion summary | model + promptVersion + scope + thread fingerprint | 30 天 |
| Comment vocabulary | promptVersion + level choice + baseUrl + model + comment fingerprint | 30 天（空结果 60 秒） |
| Wordbook | 单词（大小写无关去重），上限 500 | 用户移除前 |
| Word lookup（Wiktionary / Tatoeba） | 单词 + 来源 | 会话内存（空结果 24 小时不重试） |
| Offline HTML | storyId + document fingerprint | 30 天，最多 20 份 |
| Settings | schemaVersion | 用户重置前 |
| Workspace state | readerRatio + lastActiveStoryId | 用户覆盖前 |
| Topic reading state | storyId -> title + visitedAt + collapsed commentIds + visible commentId + in-comment pixel offset | 用户覆盖前 |

缓存 UI 只提供统一清理，不建管理中心。

## 12. 构建架构

- TypeScript `strict`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、`noUnusedLocals`。
- esbuild 输出 IIFE userscript，target ES2022，不引入框架。
- CSS 由分层事实源构建，在生产 userscript 中由构建器嵌入或生成固定 resource，不在源码手工维护副本。
- `document-start` 仅同步安装宿主皮肤；Reader DOM、工作区状态和业务 owner 延后到 `DOMContentLoaded`。入口不预创建 Reader DOM、不初始化 IndexedDB、不获取外网。
- 当前发布物为一个 `dist/hacker-news-reader-lite.user.js`。
- 本地调试物为 `work/hacker-news-reader-lite.local.user.js`。
- 体积和性能证据未触发 ADR 重审前，不拆 Core/Platform/Features Library。

## 13. 生命周期

```text
UserscriptScope
  +-- HostScope
  +-- ReaderScope (open -> close)
      +-- ThreadScope (story switch)
      +-- Translation tasks
      +-- Vocabulary tasks
      +-- Summary task
      +-- Offline serialization task
```

父 scope 销毁必须取消所有子 scope。任何请求、Observer、rAF、定时器、事件或 Object URL 都必须登记 cleanup。

## 14. 架构决策记录

- `docs/adr/0001-copy-reuse-lite-owners.md`
- `docs/adr/0002-dom-first-api-supplement.md`
- `docs/adr/0003-single-lean-userscript.md`
- `docs/adr/0004-read-only-native-delegation.md`
- `docs/adr/0005-in-page-article-extraction.md`
- `docs/adr/0006-native-external-tabs.md`
- `docs/adr/0007-host-card-list-entry.md`
- `docs/adr/0008-persistent-host-pane-navigation.md`
- `docs/adr/0009-ai-vocabulary-in-viewport.md`
