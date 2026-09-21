# ADR-0009：词汇整理随视野按需调用 AI

- 状态：已接受
- 日期：2026-09-21

## 决策

Reader 增加可选的"评论词汇整理"能力。用户显式开启后，滚动进入视野的评论原文会被送去已配置的 AI profile，换取该评论内六级及以上英文难词（单词、音标、中文释义、原句），在正文下方展示词汇区并在正文内高亮；单词可朗读与收藏，收藏进入阅读工作台的"单词本"标签。

请求复用现有 `AiCompletionClient`（`vocabulary:` operation 走 chat/completions 分支）、`TranslationTaskManager`（并发、RPM/TPM、同 key 去重、优先级晋升）与 `TranslationRuntime.scheduler`，不新建网络栈、不新增 `@grant`、不新增域名。结果按 `提示词版本 + 模型 + 评论原文指纹` 缓存在 IndexedDB，TTL 30 天；空结果缓存 60 秒。

## 原因

- "阅读时顺带积累词汇"是评论阅读的延伸，属于 Reader 会话，不属于宿主列表页。
- 开启词汇开关本身就是用户显式同意发送评论原文，因此视野内自动请求不违反"不自动发起网络请求"：性质与开启翻译后进行滚动预翻译一致。
- 复用既有 AI 与调度栈，避免第二套配额、去重与取消语义。

## 后果

- `ReaderScope` 新增词汇任务：销毁时取消全部在途请求，关闭开关时清空词汇区与高亮。
- 词汇失败不影响翻译、总结与离线下载；错误只收敛为词汇区内的可重试文案。
- 不移植参考仓库的 ECDICT 离线词库（约 750 KB）、Wiktionary/Tatoeba 在线词典与间隔重复复习调度，控制 userscript 体积。
- 设置新增 `vocabularyEnabled`（默认关闭）与 `vocabularyLevels`；"恢复默认设置"不删除已收藏单词。
