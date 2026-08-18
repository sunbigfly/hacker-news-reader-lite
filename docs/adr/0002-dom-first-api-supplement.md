# ADR-0002：DOM-first，API 只补全

- 状态：已接受
- 日期：2026-08-16

## 决策

打开评论 Reader 时优先从当前 HN 服务器 DOM 一次性建模。官方 Firebase API 用于缺失分支、手动刷新、过期快照的轻量差异检查，以及 Reader 打开期间的单路 `/updates.json` SSE 变更通知。SSE 只触发当前故事或已知父评论的增量子树补齐，不定时轮询，不默认重抓整树。

## 原因

- HN API 的评论为单 item 请求，整树需递归获取；这会对大讨论产生大量额外网络工作。
- 当前 DOM 已包含用户正在看的评论文本、顺序和缩进。
- 产品要求宿主负载最小；Firebase 变更流用一条长连接代替近实时定时轮询。

## 后果

- DOM adapter 是高风险合同，必须使用脱敏 fixture 验证。
- DOM 缺失的 dead/deleted/更多分支需要 API 降级。
- Reader 必须显示当前覆盖是否完整。
- 无后台定时轮询。
- 实时流仅属于 ReaderScope；切换 Topic、关闭 Reader 或页面销毁必须终止连接和在途增量请求。
- 只有 HN `createdAt` 不早于本次 Reader 打开时刻的新增评论才进入新消息提示；旧快照补齐不误报。
