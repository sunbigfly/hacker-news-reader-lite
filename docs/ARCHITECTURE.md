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
