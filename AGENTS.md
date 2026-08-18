# Hacker News Reader Lite 项目规则

## 默认工作入口

- 本仓库是面向 `news.ycombinator.com` 的 TypeScript 油猴阅读器。
- 开发、修复、架构调整、测试或本地构建时使用 `$develop-hackernews-reader`。
- 只有用户明确要求提交、推送或发布时才使用 `$release-hackernews-reader`。
- 产品和架构基线见 `docs/PRD.md`、`docs/ARCHITECTURE.md` 和 `docs/adr/`。

## 事实源与生成物

- 业务事实源为 `lite/src/`，样式事实源为 `lite/styles/`，油猴元数据事实源为 `lite/userscript.meta.txt`。
- `work/` 和 `dist/` 下的 userscript、CSS、manifest 与性能报告均是生成物，不直接编辑。
- 生产默认保持一个精简 userscript；只有实测或平台体积限制证明必须时才拆分 Library。
- 项目脚本尚未搭建时，先完成 `docs/IMPLEMENTATION_PLAN.md` 的 Phase 0，不伪造已可运行的验证命令。

## 复用策略

- 首选从 Awesome LinuxDo Reader 的当前 Lite 事实源复制可迁移 owner 及对应测试，再完成 HN 命名、类型和适配器改造。
- 每个复制批次必须按 `docs/REUSE_MATRIX.md` 固定源文件、目标 owner、删除的 Discourse 依赖、对应测试和完成证据。
- 不复制 Discourse 应用编排器、账号、Composer、MessageBus、已读上报、通知、WebDAV、多站点探测或重媒体依赖。
- 复制后的文件由本仓库独立拥有；不保留运行时跨仓库引用。保留 MIT 许可和必要归属。

## 产品边界

- V1 为只读阅读器：不重写投票、回复、收藏、隐藏或登录；需要时跳回 HN 原生界面。
- 只匹配 `news.ycombinator.com`，不对全网安装 userscript。
- 评论树 DOM-first：优先使用当前 HN 服务器 DOM 秒开，只在缺失分支、手动刷新或可见性恢复检查时访问官方 API。
- 不轮询、不伪造评论分数、不改写 HN `kids` 排序。
- 外链阅读器由 HN 页面内的单一可复用浮窗承载；不通过全网 `@match` 或通用 iframe 实现。

## 性能与生命周期不变量

- 阅读器未打开时：零业务网络、零轮询、不安装全页 MutationObserver。
- 请求经唯一 scheduler/gateway 去重、并发控制、取消、超时和缓存；视图不直接请求。
- 评论树使用 canonical state 和分支感知虚拟投影，挂载评论节点默认不超过 120。
- scroll/resize 测量同帧合并；缩进线优先 CSS，不引入持续 SVG 几何重算。
- 关闭 Topic、文章浮窗或整个 Reader 时，清理请求、队列、订阅、事件、Observer、定时器、DOM 和 Object URL。
- 性能结论必须来自 `docs/QUALITY_GATES.md` 规定的同环境 A/B；静态检查或历史基准不是当前浏览器证据。

## 数据、隐私与安全

- 内容与缓存仅保存在 IndexedDB/GM Storage，默认 30 天，不做遥测或云同步。
- API Key 不进入配置导出、日志、离线 HTML、fixture 或 Git。
- 只有用户显式触发翻译或 AI 总结时才发送正文。
- 外链获取仅允许 HTTP(S)，默认匿名、不带 Cookie，拒绝本机/私网/用户信息 URL，限制响应大小与可接受类型。
- 所有 HN/API/文章 HTML 在进入 Shadow DOM 和离线文档前必须经允许列表清洗。

## 工作流程

1. 读取本文件、相关项目 Skill、PRD、架构文档、实施计划和命中 ADR。
2. 固定本次 owner、源文件、测试、生成物和用户可见行为。
3. 复用任务先复制最小依赖闭包及其测试，再用目标类型/适配器替换 Discourse 依赖；不在同一批添加新产品行为。
4. 修改 TS/JS 时只对本次文件运行一次 ESLint；修复本次引入问题后最多再运行一次。
5. 运行相关最小测试、typecheck 和本地构建。构建命令在 Phase 0 固定后以 package scripts 为准。
6. 分开报告源码/测试/构建/浏览器/性能/发布证据。

## 权限与验收边界

- 未经当前请求明确授权，不打开真实浏览器、不提交、不推送、不发布。
- 浏览器授权后，使用同一浏览器/配置进行宿主原生与脚本启用 A/B；不复制 Cookie 或新建替代用户配置。
- 实现已完成但缺少要求的真实浏览器/性能证据时，状态保持“静态与构建已验证，真实验收未完成”。
