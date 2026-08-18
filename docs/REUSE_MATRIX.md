# Lite 复用与改造矩阵

## 1. 策略

历史参考源为 `https://github.com/sunbigfly/awesome-linuxdo-reader`。源项目使用 MIT License，本项目保留必要归属；固定 commit 与逐文件 SHA-256 记录在 `reuse-manifest.json`。

这些记录仅用于说明早期代码来源。Hacker News Reader 是独立项目，不读取参考仓库的活动工作树，不保留跨仓库运行时或构建依赖，复制后的源码、测试和发布产物均由本仓库独立拥有。

复用的单位是“owner + 最小依赖闭包 + 对应测试”，不是散落函数，也不是整仓复制。每个批次必须分为：

1. 原样复制并记录源 SHA-256。
2. 运行复制过来的测试，建立行为基线。
3. 替换 Discourse/LDP 命名、标识类型与适配器。
4. 删除 HN 不需要的分支，补 HN 合同测试。
5. 证明目标文件不再导入 `discourse/`、LinuxDo 站点服务或未授权功能。

## 2. A 级：优先复制，小改命名或类型

| 源 owner | 目标作用 | 主要改造 | 同步复制的证据 |
| --- | --- | --- | --- |
| `lite/src/kernel/lifecycle.ts` | 会话/视图/请求统一清理 | 仅命名和诊断文案 | `lite/tests/lifecycle.test.ts` |
| `lite/src/kernel/signal.ts` | 局部状态变更 | 原则上原样保留 | 相关 consumer 测试 |
| `lite/src/kernel/repeat-action-gate.ts` | 防重入交互 | 原则上原样保留 | 原测试 |
| `lite/src/dom/event-target.ts` | Shadow DOM composed event 定位 | 替换 CSS 命名时更新合同 | 外点/Escape 测试 |
| `lite/src/dom/html-element.ts` | 小型 DOM 构建器 | 命名适配 | consumer 测试 |
| `lite/src/dom/floating-surface-wheel.ts` | 浮窗滚轮边界 | 替换 class 合同 | `lite/tests/floating-surface-wheel.test.ts` |
| `lite/src/network/request-scheduler.ts` | 统一并发、优先级、取消、超时 | lane 精简为 HN/API/translation/AI/article | scheduler 测试 |
| `lite/src/network/request-contract.ts` | 网络描述合同 | 移除 Discourse 字段 | 合同测试 |
| `lite/src/cache/indexeddb-response-cache-store.ts` | IndexedDB 持久化 | DB/store 命名与 schema 版本 | `lite/tests/indexeddb-response-cache-store.test.ts` |
| `lite/src/cache/response-repository.ts` | 内存 + 持久缓存 owner | 用 HN 缓存 identity 替换 authScope | 相关 repository 测试 |
| `lite/src/translation/translation-text.ts` | 保护占位符与段落指纹 | 增加 HN code/link/quote fixture | 翻译文本测试 |
| `lite/src/translation/translation-task-manager.ts` | 翻译/AI 任务限流与优先级 | 降低默认并发，保留可见内容优先 | `lite/tests/translation-task-manager.test.ts` |

## 3. B 级：复制算法与测试，替换宿主依赖

| 源 owner | 保留 | 必须替换/删除 | 目标 owner |
| --- | --- | --- | --- |
| `lite/src/dom/reply-tree.ts` | 事务 commit、环检测、parent/children/depth/root 缓存 | `discoursePostNumber` 替换为 `hnItemId` | `thread/comment-tree.ts` |
| `lite/src/dom/reply-tree-repository.ts` | 唯一 ingress、覆盖率、串行快照持久化 | Discourse ingest source/version 替换为 DOM/API/cache source revision | `thread/comment-tree-repository.ts` |
| `lite/src/stream/virtual-root-layout.ts` | prefix layout、overscan、测量、scroll compensation | 从“根楼层”改为“可见分支窗口”，防止巨型单根突破 120 节点 | `stream/virtual-comment-layout.ts` |
| `lite/src/stream/virtual-stream-dom-controller.ts` | 挂载/卸载、spacer、窗口 commit | PostView/ReplyTreeRepository 替换为 HN projection ports | `stream/virtual-comment-dom-controller.ts` |
| `lite/src/stream/virtual-stream-frame-controller.ts` | ResizeObserver 只记录、rAF 合并 commit | `data-post-number` 替换 `data-comment-id`；增加滚动期测量延后 | `stream/virtual-comment-frame-controller.ts` |
| `lite/src/shell/reader-workspace.ts` | 工作区几何与屏幕边界 | 只保留评论 Reader 的比例嵌入状态 | `shell/reader-workspace.ts` |
| `lite/styles/40-reply-tree.css` | 分段主干、子楼弯头、末子节收尾规则 | 用 HN 扁平虚拟投影和 monogram 头像替换 Discourse 嵌套 DOM | `shell/reader-view.ts` + `styles/10-reader.css` |
| `lite/src/translation/reader-translation-config.ts` | 多 AI Profile、模型选择、Prompt、配额、脱敏存储 | 删除非必要模型元数据和复杂 benchmark UI | `translation/translation-config.ts` |
| `lite/src/translation/translation-request-adapter.ts` | Google/Microsoft descriptor、回退、占位符验证、AI Completion、指纹缓存 | 删除 LinuxDo credit/connect、Discourse gateway 与非必需公共模型元数据 | `translation/translation-request-adapter.ts` 与 `ai/ai-completion-adapter.ts` |
| `lite/src/translation/reader-translation-controller.ts` | 原文/双语/译文模式、可见段预载 | Discourse post metadata 换为评论段落 port；精简动画 | `translation/translation-controller.ts` |
| `lite/src/post/reader-topic-custom-summary.ts` | 树感知 payload、范围、上下文预算、真实节点引用 | Discourse Topic/Post 替换为 HN Story/Comment；移除图像、分享卡 | `summary/discussion-summary-service.ts` |
| `lite/src/archive/reader-topic-offline-document.ts` | 安全 JSON 序列化、搜索、折叠、虚拟窗口、单 HTML runtime | Discourse schema、reaction/quote/archive manager 换为 HN Story/Comment；删除重型管理界面 | `offline/offline-document.ts` |

## 4. C 级：不复制

| 源域 | 原因 |
| --- | --- |
| `lite/src/app/reader-browser-runtime.ts` | 超大 Discourse 编排器，会把整个应用复杂度带入 HN |
| `lite/src/userscript/main-lite-bootstrap.ts` | 包含多站点探测、Discourse host API、账号、样式与大量 feature wiring |
| `lite/src/discourse/` | HN 不使用 Discourse 模型、原生 API、Composer 或 MessageBus |
| `lite/src/post/` 中投票/收藏/管理/Composer owner | V1 只读，互动返回 HN 原生页 |
| `lite/src/notification/`、`user/`、`bookmark/`、`history/`、`sync/` | 不属于阅读器核心目标 |
| `lite/src/monitor/reader-resource-monitor.ts` | 用户不需要资源仪表盘；性能使用开发验收工具测量 |
| `lite/src/media/` 的 KaTeX/HLS/图库/轮播 | 提高包体和运行复杂度，非本产品必需 |
| `lite/src/queue/reader-topic-download-manager.ts` | 下载任务史和批处理过重；V1 只生成当前阅读的单 HTML |
| Greasy Fork Core/Platform/Features 三 Library runtime | 当前没有体积证据，提前拆分会增加解析和发布成本 |

## 5. 新建而非复制的 HN 适配器

- `host/hn-route.ts`：识别列表、`item?id=*`、故事链接和原生操作。
- `host/hn-dom-adapter.ts`：从当前服务器 DOM 一次性建模。
- `hn-api/hn-api-adapter.ts`：读取官方 `/v0/item/{id}.json`，只补缺失与手动刷新。
- `article/article-fetch-adapter.ts`：匿名 GM HTTP、URL 安全策略、响应大小/类型限制。
- `article/article-extractor.ts`：惰性 DOM 主体提取与允许列表清洗。
- `userscript/main.ts`：仅组合 HN 入口和按需功能，不演变为大型服务定位器。

## 6. 复用批次验收模板

每批在实施计划中记录：

- 源 commit / 文件 / SHA-256；
- 复制的测试及基线结果；
- 目标文件和 owner；
- 替换的 Discourse/LDP 依赖；
- 删除的无关功能；
- HN 新增合同测试；
- 相关 ESLint、typecheck、测试和构建结果；
- 是否做了真实浏览器/性能验收。

## 7. 字体设置适配批次

- 参考 commit：`eec5e110d6e003c790947df294ef05a44e8bac8d`。
- 参考 owner：
  - `lite/src/settings/reader-settings-view.ts`，SHA-256 `f152c6e3680c24741e7261deceaf4e5c694b6a9873691c807c9a37d03a50ecdf`；
  - `lite/styles/70-settings.css`，SHA-256 `d6c63c36b8ed2b83a03aaed08c513e859524627b74efba2a21a27919b255e3d5`；
  - `lite/tests/reader-settings-view.test.ts`，SHA-256 `b5a7735326e579dbbcd4fa7dc92798faee280fdb64f32a0e4206c0d5a5e9651d`；
  - `lite/src/settings/reader-font-settings-form.ts`，SHA-256 `2c755f4e0b7744d8751e0b0ad8cd4c2badcb0c2f048c5bbaec27a787b88fa9bc`；
  - `lite/src/font/reader-font-style-controller.ts`，SHA-256 `e72d3354e4db54f88242dc0e767ac0908f5aeb34dc68b6dc2e338de1e263302d`；
  - `lite/tests/reader-font-settings-form.test.ts`，SHA-256 `fbfaa653f00842cb266b776f0105952bd5dd9a6269ec5a0baa447a8449c5a567`。
- 目标 owner：`lite/src/settings/settings-store.ts`、`lite/src/settings/local-font-picker.ts`、`lite/src/shell/reader-view.ts`、`lite/styles/10-reader.css`，回归为 `lite/tests/settings-store.test.ts`、`lite/tests/local-font-picker.test.ts` 和 `lite/tests/reader-view.test.ts`。
- 适配复用：LinuxDo Reader 的左侧品牌/搜索/分组导航、右侧单分区内容、统一状态与保存底栏；字体部分保留预设、本机字体名称清洗、浏览器字体自动查询、中文字体优先排序与命名、可搜索选择、字重、字号滑杆、实时预览与统一保存/放弃语义。标题与正文复用同一次字体查询，但持久化为独立选择。
- 删除的 Discourse 依赖：用户/站点/同步/日志/性能等业务面板、原站和 Composer 作用域、宿主字体接管、外部字体渲染检测、设置浮窗拖动、复杂草稿控制器和 Discourse/LDP 运行时字段。
- HN 行为边界：标题字体只影响 Reader 原标题与译题；正文字体继续影响 Reader 评论正文及宿主评论正文，不修改代码块的等宽字体。

### 7.1 字体渲染核心补充批次

- LinuxDo Reader 参考 commit：`be31d65c6592701bf57be445e6579d1cfe182bb7`。
- 参考 owner：
  - `lite/src/font/reader-font-style-controller.ts`，SHA-256 `e72d3354e4db54f88242dc0e767ac0908f5aeb34dc68b6dc2e338de1e263302d`；
  - `lite/styles/00-foundation.css`，SHA-256 `8b69305139828c2239a9ff9f6ca10b72113d0148f09611157f1aad40bbaf968e`；
  - `lite/tests/reader-font-settings-form.test.ts`，SHA-256 `b4ee5903078c1b2e465892ba67831a6a51278776445185b67595944c59ddd013`。
- 上游参考：[F9y4ng / GreasyFork-Scripts](https://github.com/F9y4ng/GreasyFork-Scripts/) `Font Rendering.user.js`，当前仓库快照 `b7c5b3ddc1dddf692915801c77ecb7dd4b94eee2`，Font Rendering 最后变更 `4119be90d7aa731a470e6718c36f8476b1f2f4af`，许可证为 [GPL-3.0-only](https://github.com/F9y4ng/GreasyFork-Scripts/blob/master/LICENSE)。
- 目标 owner：`lite/src/font/reader-font-rendering.ts`、`lite/src/settings/settings-store.ts`、`lite/src/shell/reader-view.ts`与 `lite/styles/10-reader.css`；回归为 `lite/tests/reader-font-rendering.test.ts`、`lite/tests/settings-store.test.ts`与 `lite/tests/reader-view.test.ts`。
- 适配复用：从 MIT 授权的 LinuxDo Reader 适配 owner 保留 Blink/Gecko/WebKit 分型参数、macOS 平滑、字体光学尺寸、字距、描边和阴影，并在字体面板提供即时预览与持久化开关。不直接复制 GPL 上游脚本。
- 拒绝复制：上游的全站字体重写、缩放、视口修正、站点白名单、配置与导入导出系统，以及 LinuxDo 的原站接管、Composer 和外部渲染检测。
- HN 行为边界：内置渲染只作用于 Reader Shadow DOM，代码块、键盘标记与 SVG 图标显式排除；不接管 HN 原站全局字体。

## 8. 译文呈现样式适配批次

- 参考 commit：`e44d908714300c69c54940dfa6cb1481bc2c38a5`。
- 参考 owner：
  - `lite/src/translation/reader-translation-presentation.ts`，SHA-256 `011f9400b16ab12e0604b4f2b355ddc9d8e355aa669e0b74255066acf7779477`；
  - `lite/src/settings/reader-translation-settings-form.ts`，SHA-256 `1d59458c752213e131a12c3d56abb07220dd4232145923581520ba50e0237cca`；
  - `lite/styles/30-stream.css`，SHA-256 `8e22cb5763bdb8121ed8e2f4c0dffcc28bf25f471f536c1b34a46e7a4a1ec048`；
  - `lite/tests/reader-translation-settings-form.test.ts`，SHA-256 `bf5058efd0c99582c9334ac1e573eb71798faea3130c0ca0c4f88bdca9d5a5d8`。
- 目标 owner：`lite/src/translation/translation-presentation.ts`、`lite/src/settings/settings-store.ts`、`lite/src/shell/reader-view.ts`、`lite/styles/10-reader.css` 与 `lite/src/offline/offline-document.ts`；回归为 `lite/tests/settings-store.test.ts`、`lite/tests/reader-view.test.ts` 和 `lite/tests/offline-document.test.ts`。
- 适配复用：保留淡灰引用、自然正文、弱化译文、分隔线、下划线、柔和高亮和纸张卡片七种双语译文主题；选择器即时预览、统一保存，并由在线 Reader 与离线 HTML 复用。HN 默认使用截图所示的纸张卡片。
- 删除的 Discourse 依赖：ReaderPreferences 大型 schema、独立 TranslationSettingsForm、设置中心 DOM helpers、翻译动画、Profile 仓库、`ldp-*` 类名与主应用 bootstrap 接线。
- HN 行为边界：只改变双语模式中的译文区块；仅原文、仅译文、翻译请求、滚动预翻译范围、代码和链接保护均保持不变。

## 9. 翻译队列与可见任务晋级适配批次

- 参考 commit：`998e9535638a4a57e8847b9dc8dc11a4d9d230a8`。
- 参考 owner：
  - `lite/src/translation/reader-translation-controller.ts`，SHA-256 `ab1a8faac8ddcd868f8fccd4c16b5983c5a3443b60d11cbece16027f8e90d74a`；
  - `lite/src/translation/translation-task-manager.ts`，SHA-256 `25743682d88ab5f2e9c66c8d9da914aef33eb3cd435fb907b3a2d35501226562`；
  - `lite/tests/reader-translation-controller.test.ts`，SHA-256 `b179ad78abae9a42a6ea80d302920b1b4365cb3ed4099827b9b2851129e6a0b0`；
  - `lite/tests/translation-task-manager.test.ts`，SHA-256 `aad5a42c0b30caa9f2c580ae1e861f79927bb938b23dc160b1e92dcf3bf6765e`。
- 目标 owner：`lite/src/translation/translation-task-manager.ts`、`lite/src/translation/translation-service.ts`、`lite/src/app/reader-controller.ts`；回归为 `lite/tests/translation-task-manager.test.ts`、`lite/tests/translation-service.test.ts` 和 `lite/tests/reader-controller.test.ts`。
- 适配复用：保留五路后台 worker 与第六路可见急行 worker、interactive > visible > prefetch、同稳定 key 订阅去重、排队/在途任务原地晋级、动态配额优先级和逐段流式回填。
- HN 改造：段落身份与缓存继续独立；自定义 AI 按评论轮转顺序跨评论合包，单包最多 8,000 字符，公共翻译继续使用最多 6 段的有界批次。滚动只追加或晋级，不取消有效在途请求。
- 拒绝复制：LinuxDo 的 Discourse DOM/Topic 生命周期、1,400/3,500 字符批次参数、通知与重试编排；HN 使用当前 API 对照实测支持的 8,000 字符 AI 包预算和 Reader 生命周期。
