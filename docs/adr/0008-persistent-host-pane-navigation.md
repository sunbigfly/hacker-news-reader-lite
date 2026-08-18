# ADR-0008：宿主只承载顶部 Tab 与原生回复表单

- 状态：已接受
- 日期：2026-08-17

## 决策

`HnHostNavigationController` 在 capture 阶段只接管顶部 `welcome`、`new`、`threads`、`past`、`comments`、`ask`、`show`、`jobs`、`submit` 导航与 Reader 回复命令显式发起的 `/reply`。这些页面由 `HnHostPageAdapter` 使用页面原生同源 `fetch` 请求，`HnHostController` 保留顶栏外壳、宿主滚动容器和 `#hn-reader-workspace`，仅事务替换顶栏之后的宿主内容。

无 modifier 主键点击任意 `item?id=*` 时，capture owner 阻止它进入宿主 loader，改为调用 Reader item 入口。故事 ID 直接打开；评论 ID 通过已载入树、当前 DOM 或官方 API `parent` 链解析所属故事，然后定位真实评论。该操作不替换宿主内容、不写宿主 history、不改变宿主 URL。如果 userscript 直接从 `item` URL 启动，当前 DOM 先交给 Reader，左侧再静默显示默认 `news` tab，地址栏仍保留 item 目标。

Reader 评论页刷新、宿主 tab 导航和 More 共享同一个有界 HN HTML scheduler，总并发为 2。Reader 恢复后的后台刷新可占用一个通道，宿主 tab 交互保留另一个通道；More 保持更低的 supplement 优先级。所有请求仍使用同一 scheduler 的同 key 去重、取消和生命周期回收。

一个导航被新目标替代且失去所有订阅者时，scheduler 在中止底层请求的同时立即释放该 key。底层 Promise 异步收尾前的同 key 新导航创建独立 entry；旧 entry 收尾时只能删除自己，不得删除后继 entry。

替换成功后同步 document title、`html[op]`、顶栏选中态、账号区、history 和宿主滚动位置；`popstate` 复用同一事务。Reader 已打开时始终保持右侧占位，只有 Reader 自身的关闭动作才销毁工作区。请求或解析失败时不改变当前宿主 DOM，并显示可重试的短提示。

外站链接、modified 点击、显式新标签和表单提交不被截获。不在允许集中的用户页、帮助页等 HN 页面也不导入宿主面板。Reader 的“回复”只把 HN 原生回复表单载入左侧宿主并提供历史返回入口；评论 POST、投票、hide、收藏和登出等真正改变 HN 状态的动作仍走原生路径，不建立第二套写操作适配器。

## 原因

- 宿主面板是稳定的 HN 列表/回复区，`item` 讨论语义属于 Reader；将两者都投影到宿主会破坏这个空间边界。
- 标准页以 `#hnmain` 顶栏后内容为最小可替换边界；旧式静态页使用一次性的宿主正文包装，不需要引入全页 MutationObserver 或第二份宿主状态。
- 将导航请求设为 HN 交互优先级，可避免被后台 More 请求阻塞而表现为 Tab 无法点击。

## 后果

- userscript 会在任意 HN HTML 路由安装宿主导航 owner，但宿主 loader 必须先通过精确路径允许集。
- 导入的 tab/回复 HTML 不执行目标页脚本；现有 HN 脚本仍负责原生交互。
- 宿主替换、卡片投影、分页和翻译使用独立可销毁 scope；再次导航或页面销毁时必须恢复原始 DOM 且取消在途请求。
