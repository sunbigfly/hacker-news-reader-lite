# Hacker News Reader Lite 实施计划

## 1. 计划原则

- 以可交付阅读纵切为单位，不先造大型通用框架。
- 能从参考 Lite 复制的 owner 与测试先复制，再做 HN 解耦；不从零重写。
- 复制基线、解耦改造和新功能分批完成，不在同一差异中混合。
- 每个阶段都有独立退出条件；未通过时不启动后续高层功能。
- 功能全包含，界面始终只保留评论 Reader 和极简设置两个表面；外链交给浏览器原生新标签。

## 2. 阶段总览

| Phase | 交付 | 前置 | 主要门禁 |
| --- | --- | --- | --- |
| 0 | TypeScript/userscript 工程与复用工具链 | 无 | strict typecheck、空入口构建、metadata 审计 |
| 1 | 复用 kernel/network/cache 基础 | Phase 0 | 原测试基线 + HN 命名后测试 |
| 2 | DOM-first HN 评论 Reader + 虚拟树 | Phase 1 | fixture 合同、1,000 评论性能 fixture、只读行为 |
| 3 | Google/Microsoft/自定义 AI 翻译 | Phase 2 | provider 回退、占位符、取消、缓存 |
| 4 | 外链原生新标签 | Phase 1 | URL 安全、目标属性、无页内浮窗 |
| 5 | 讨论 AI 总结 | Phase 2 | 树引用、上下文预算、分区缓存 |
| 6 | 单 HTML 离线下载 | Phase 2, 3, 5 | 断网搜索/折叠/译文/总结、XSS 安全 |
| 7 | 轻量化硬化与发布验收 | Phase 0..6 | 同浏览器 A/B、20 次循环、安全/敏感信息扫描 |

## 3. Phase 0：工程骨架

### 实现

- 创建 `package.json`、strict `tsconfig`、ESLint 和 esbuild 配置。
- 创建 `lite/src/userscript/main.ts`、`lite/styles/`、`lite/userscript.meta.txt`。
- metadata 只匹配 HN，`@run-at document-start`；启动阶段只同步安装宿主防闪皮肤，Reader 与业务 owner 等待 `DOMContentLoaded`；初始只申请后续功能确实需要的 GM 权限。
- 创建本地调试和生产单 userscript 构建器，输出 bytes 与 SHA-256。
- 创建 metadata/权限/生成物审计脚本。
- 创建复用 manifest 格式：源文件、源 hash、目标文件、状态、测试。

### 预期命令合同

Phase 0 需将以下命令写入 package scripts，名称只在实现时由当前脚本复核一次：

```text
npm run hn-lite:lint
npm run hn-lite:typecheck
npm run hn-lite:test
npm run hn-lite:build:local
npm run hn-lite:build
npm run hn-lite:verify
```

### 退出条件

- 空 userscript 本地版与生产版可重复构建，无警告。
- strict typecheck、ESLint、metadata 审计和生成物 hash 通过。
- userscript 安装后未显式打开 Reader 时不发请求、不创建大型 DOM。真实浏览器证据需当前授权。

## 4. Phase 1：复用基础 owner

### 复用批次

1. kernel：`LifecycleScope`、`Signal`、repeat gate。
2. DOM helpers：composed event、element builder、floating wheel。
3. network：request contract、scheduler、coordinated client 的最小闭包。
4. cache：identity、response repository、IndexedDB store。

每批同步复制相关测试。先以本仓库模块路径运行原行为测试，再替换命名和删除 Discourse 字段。

### HN 改造

- 定义 `StoryId` / `CommentId` / `RequestLane`。
- scheduler lane 收敛为 `hn-interactive`、`hn-supplement`、`translation`、`ai`。
- cache identity 收敛为 HN content fingerprint，不使用 Discourse authScope。

### 退出条件

- 复用 manifest 列出所有源/目标 hash。
- 目标基础模块没有 `discourse/`、LinuxDo 站点或参考项目全局符号依赖。
- 复制测试和 HN 新增合同通过。

## 5. Phase 2：阅读主链

### 2A：HN host/DOM

- 建立脱敏 fixture：列表、普通讨论、深层树、deleted/dead、缺失/更多、纯文本 Ask HN。
- 实现 route、story link、comment entry 与 modifier/new-tab 语义。
- 在不重建宿主列表的前提下投影紧凑 Discourse 式故事卡片、同气质的 `/newcomments`/`/threads` 评论卡片和 Reader 风格顶部标签栏；评论卡片空白区与卡内 HN 讨论链接进入 Reader，投票、作者和外站链接保留原生；皮肤先于首次可见绘制安装，顶部只保留 Logo，Tabs 在宿主宽度不足时自动换行且用户区保持靠右；故事卡片空白区/标题与 Enter/Space 进入 Reader，modified 标题点击与其他原生操作保留。
- Reader 关闭时顶部 tab 保持原生跳转；Reader 打开后，只有顶部 tab 和 Reader 回复命令发起的 `/reply` 才通过共享、总并发为 2 的 HN HTML scheduler 静默获取并事务替换左侧宿主。`item?id=*` 在 capture 阶段统一改发 Reader；评论 ID 沿官方 API parent 链解析所属故事并定位，不更改宿主 tab、内容或 URL。已访问 tab 使用有上限的会话内 LRU 缓存立即切换并后台重新验证；失败保留当前宿主页，其他 HN 页面、写操作、modifier 和新标签语义不接管。
- 导入 `submit`/`reply` 原生表单时把宿主临时扩展到至少 62%，字段和文本框继续受当前面板宽度约束；用户主动拖动分隔线时解除自动宽度并按既有语义保存新比例，否则离开表单后恢复原有分栏比例。
- 宿主滚动进入底部阈值后经页面原生同源 adapter 自动请求 More；滚动捕获与 More 可见性哨兵共同触发，与 Reader 评论页和宿主 tab 共享同一个有界 HN HTML scheduler，More 使用更低的 supplement 优先级，同 URL 去重、可取消，首次失败只自动重试一次。新行插入 Footer 前并复用卡片/翻译合同，持续失败显示提示并保留手动 More。
- 实现一次性 DOM parser，选择器仅存在于 host adapter。

### 2B：复用 CommentTree

- 复制 ReplyTree topology/repository 和相关测试。
- 替换标识、ingest source、snapshot schema。
- 增加 DOM/API/cache 版本冲突、环、重排、缺失父节点测试。

### 2C：分支感知虚拟流

- 复制 virtual layout/dom/frame 算法与测试。
- 从 root block 窗口改为 visible entry 窗口，保证单巨型根分支也不超过 120 挂载节点。
- 实现折叠、展开、祖先保留、锚点定位、测量与滚动补偿。
- 使用 CSS 分支线，不复制 SVG 线几何。
- Reader 首屏完成后通过可取消 idle slice 全帖预热搜索文本、翻译分段、内容指纹、树索引和虚拟估算高度；不发网络或 AI。

### 2D：精简 Shell

- 一个 ShadowRoot Reader、一条工具栏、一个评论流。
- 默认 48%/52% 的嵌入工作区提供可拖动分隔线，持久保存边界比例，并为宿主与 Reader 使用极细灰色独立滚动条；宿主滚动条从冻结标题下方开始。
- 设置侧栏底部提供跟随系统/浅色/深色选择；变更即时预览宿主与 Reader 的完整色板，取消时共同回滚，保存后共同持久化。
- 字体面板在用户进入时自动读取浏览器可用字体家族，以中文字体优先、中文名称优先的可搜索下拉分别设置 Reader 标题和评论正文；不支持或未授权时保留手动名称降级，两处均即时预览。同一面板可即时预览并持久化 Reader 内置字体显示优化开关，关闭后不应用平滑、描边或阴影样式。
- Reader 打开后优先用已验证的 Thread 快照热启动首屏，再后台抓取 HN 评论页原子替换 canonical tree；未打开时不得借预热读取缓存或发网络。
- Reader 点击后先用列表 Story 预览立即挂载 Shell；缓存和评论页均先投影最多 48 条，至少完成一次绘制后再恢复/解析全量评论，且全树替换保持当前评论锚点。
- Reader 成功挂载后立即记录 StoryId；Reader 关闭时在用户名左侧显示恢复入口，点击后经现有页面抓取主链打开最后帖子，同时高亮、滚动显露宿主列表中对应卡片；Reader 打开期间隐藏入口，显式当前帖入口优先。
- 仅保留阅读、定位、翻译、总结、离线、原站和关闭入口；自动翻译开启时在 Reader 原标题下显示中文译题副标题，同时为所有故事列表生成原宿主 CSS 的译题副标题、为评论流生成用户评论译文；宿主与 Reader 共用设置中的翻译服务、模型和提示词，不共用 Reader 译文呈现样式。
- 原生投票/回复跳回 HN，不创建写操作适配器。

### 2E：API supplement

- 实现只登记 item endpoint 的 descriptor 与 adapter。
- 实现缺失分支、手动刷新、超过 5 分钟的可见性恢复检查，以及 ReaderScope 内单路 `/updates.json` SSE 触发的当前讨论增量子树补全。
- 同 item 请求去重，关闭 Thread 全部取消。

### 退出条件

- fixture 中的顺序、父子、deleted/dead、缺失和锚点合同通过。
- 1,000 评论 fixture 挂载 DOM 不超过 120，反复窗口切换无重复/丢失。
- 1,000 评论预热按每片最多 32 条、最长 8 ms 完成，关闭前取消不留下任务。
- Reader 未打开且未进入 More 阈值时无分页请求；始终无全页 Observer。
- 连续触发滚动不重复加载同一 More URL；关闭页面会取消飞行请求，最后一页 Footer 位置正确。
- 卡片与顶部栏仅做本地 DOM/CSS 投影；投票、用户、hide 与 modifier 语义保持，故事/评论 `item` 链接进入 Reader 而不替换宿主。
- 关闭 Reader 后 ShadowRoot 下业务 DOM 与所有 scope 清理。

## 6. Phase 3：翻译

### 复用与精简

- 复制 translation text、task manager、config、request adapter、controller 的最小闭包与测试。
- 保留 Google/Microsoft descriptor、回退、占位符、指纹缓存、AI Completion、取消和配额。
- 删除 LinuxDo credit/connect、Discourse gateway、图像模型、分享卡和复杂模型 benchmark UI。

### HN 纵切

- 评论 PostView 提供受保护 code/link/quote 分段。
- 段落保留独立身份并按正文顺序入队；自定义 AI 在 8,000 字符预算内跨评论合包，公共翻译保留最多 6 段的有界批次。宿主与 Reader 共用页面级唯一队列，后台最多使用 5 路并为可见正文保留第 6 路；滚动只追加或晋级稳定任务，不取消、重建在途请求。顶部至少预加载两屏，用户可显式翻译当前分支。
- 待译段落立即显示骨架占位，AI SSE 译文每次到达都就地更新并显示流式动画，不等待整条评论。
- 原文/双语/仅译文模式不改变 canonical comment HTML。

### 退出条件

- Google 成功、Google -> Microsoft 回退、超长 Microsoft -> Google、双失败保留原文的合同通过。
- AI 只在显式选择 Profile 后请求。
- 独立段落身份、AI 有界合包、正文顺序入队、稳定包去重与晋级、滚动不取消、占位失败收口和 AI SSE 局部重绘合同通过。
- 代码、链接和占位符完整，重复段落命中缓存。
- 关闭/切换 Topic 取消队列、配额等待和飞行请求。

## 7. Phase 4：外链原生新标签

### 实现

- HN 外部标题保留原始 URL；普通点击进入 Reader，Ctrl/Cmd 点击使用 `_blank` 与 `noopener noreferrer`。
- Reader 工具栏外链命令复用 URL 安全策略并调用浏览器原生新标签。
- 删除文章浮窗、抓取、翻译、总结和运行时缓存组合。

### 退出条件

- 外链 URL 安全合同和宿主链接属性测试通过。
- 真实浏览器点击打开新标签且 Reader 内不生成文章浮窗 DOM。

## 8. Phase 5：AI 总结

### 讨论总结

- 复制 tree-aware custom summary 的 scope/budget/payload 算法和测试。
- 替换为 HN Story/Comment/item URL，删除图片上传、分享卡、Discourse native summary。
- 支持整个已加载讨论或当前分支，简短/标准/详细长度。
- 输出核心观点、共识、争议、重要分支和真实 item 引用。

### 退出条件

- 没有 AI Profile 时仅提示配置，不发请求。
- 超过模型预算时按明确规则截断并标注。
- 全帖与分支总结缓存不串用，refresh 只绕过当前 operation 缓存。
- 所有 item 引用都映射到输入中存在的评论 ID。

## 9. Phase 6：离线下载

### 复用与精简

- 复制 offline document 的安全序列化、搜索、折叠和虚拟窗口算法与测试。
- 替换为 HN Story/Comment schema。
- 删除 Discourse archive/reaction/quote 和批量 download-history manager；仅保留本项目自有的轻量完成记录仓库。
- 下载前复用缓存并经统一 TranslationService 补齐当前快照全部可翻译评论，失败时不生成残缺文件。
- 只将当前标题/正文字体和正文字号字段传入离线 owner，复用 `readerFontFamilyCss` 生成与在线 Reader 一致的字体变量，并同步 `--hnr-font-scale`；不传递完整设置或密钥。
- 添加全文译文和讨论总结投影。
- 总结洞察、全部帖子总结历史、当前下载进度和全部帖子下载历史复用同一个阅读工作台浮窗。
- 下载进度显式呈现准备译文、生成 HTML 和保存记录；完成 HTML 独立存入 IndexedDB，全局元数据索引最多保留 20 份并支持再次下载。

### 退出条件

- 单 HTML 在断网下可显示文字/样式，可搜索、折叠、切换译文和跳转 item 锚点。
- 离线标题与评论正文使用下载时已保存的 Reader 字体栈，评论正文使用已保存的字号，不回退到固定默认字体/字号（除非所选本机字体本身不可用）。
- 未满足全文翻译时不触发浏览器下载；成功时离线数据覆盖当前快照中全部可翻译评论。
- 已完成 HTML 在本地历史中可再次下载；过期或统一清缓存后明确提示不可用。
- 远程图像不可用时不影响正文结构。
- 离线文件不含 API Key、Cookie、请求头、GM storage dump 或未使用缓存。
- 恶意 `</script>`/字符分隔符/属性协议 fixture 无法逸出数据容器。

## 10. Phase 7：硬化与发布验收

### 静态与构建

- 全量 strict typecheck、测试、CSS/metadata/userscript 审计。
- 复用 manifest 完整，Discourse/LinuxDo/无关功能导入扫描为零。
- 生产 userscript 的 bytes/SHA-256 与元数据报告稳定。

### 真实浏览器

只在当前请求明确授权后执行：

- 同一 Chrome 配置中 HN 原生 vs userscript 启用 A/B。
- 4× CPU，5 组冷/热 1,000 评论打开。
- 可见滚动、折叠/展开、定位、翻译、讨论总结、外链新标签、离线下载。
- 20 次 Reader 开关和外链新标签行为检查。
- 堆、DOM、事件、Observer、定时器、Object URL 和网络空闲证据。

### 退出条件

- `docs/QUALITY_GATES.md` 所有门禁有对应证据。
- 没有为过性能门禁删除 PRD 功能；只能优化执行路径。
- 没有发布授权时，只交付本地验收产物，不提交/推送/发布。

## 11. 临界路径

```text
Phase 0 -> Phase 1 -> Phase 2 -> Phase 3
                         |          |
                         +------> Phase 4
                         |          |
                         +----------+--> Phase 5 -> Phase 6 -> Phase 7
```

Phase 2 是整个产品的风险中心：如果 DOM 合同、树正确性或分支感知虚拟化不稳定，不应用翻译、AI 或离线功能遮盖问题。
