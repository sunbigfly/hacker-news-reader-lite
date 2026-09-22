# HN Reader Lite 评论词汇整理设计

- 日期：2026-09-21
- 状态：已确认，待实现
- 迁移来源：`forum-translater` 的词汇整理 owner（`vocabulary*`、`wordbook*`）
- 相关决策：`docs/adr/0009-ai-vocabulary-in-viewport.md`

## 1. 目标与用户可见行为

开启"评论词汇整理"后，Reader 的每条评论正文下方出现一个词汇区：由已配置的 AI 从该评论原文筛出值得记的英文难词，展示 `单词 · 音标 · 中文释义`，正文中的对应单词以彩色 ink 下划线高亮，鼠标悬浮、键盘聚焦或移动端点按均可弹出词卡；点按高亮只打开词卡，不继续触发其所在的原链接。卡片内可朗读、可收藏；收藏的单词出现在阅读工作台的"单词本"标签中，可搜索、排序、分页查看并跳回收藏来源。

不开启时：零请求、零高亮、零词汇区 DOM、零设置占用。

## 2. 非目标

- 不移植 ECDICT 离线词库（`wordbook-ecdict-data.ts` 约 750 KB）与 Wiktionary / Tatoeba 在线词典查询。
- 不实现间隔重复复习调度（`due` / `stage` / `reviewWord`）。
- 不对译文正文做词汇高亮（仅原文；译文可用于例句翻译，不进入高亮目标）。
- 不在宿主列表页、离线 HTML、工作台摘要中提供词汇整理。
- 不新增 `@grant`、`@connect` 或任何词典域名。

## 3. 词汇来源与触发时机

- 每条评论一次 AI 请求，`operation` 前缀 `vocabulary:`，复用 `AiCompletionClient.complete` 的 chat/completions 分支。
- 只对**滚动进入视野**的评论发起；缓存命中时同步显示，不发起请求、不阻塞正文。
- 复用 `TranslationTaskManager` 做并发（总并发 6）、RPM/TPM 配额、同 key 去重与优先级晋升；复用 `TranslationRuntime.scheduler` 与 `IndexedDbCacheStore` 实例，不新建 worker 池。
- 提示词筛选六级及以上词汇，单条评论最多返回 6 词。

## 4. 新增文件与职责

| 文件 | 职责 | 关键导出 |
| --- | --- | --- |
| `lite/src/vocabulary/model.ts` | 类型与逐字段校验，拒绝非法 word 与越界长度 | `VocabularyWord`、`normalizeVocabularyWords`、`VOCABULARY_MAX_WORDS` |
| `lite/src/vocabulary/prompt.ts` | 提示词与版本常量（版本进缓存 key） | `VOCABULARY_PROMPT`、`VOCABULARY_PROMPT_VERSION` |
| `lite/src/vocabulary/service.ts` | 唯一请求入口：缓存 → tasks → 解析 → 写缓存，视野优先级晋升 | `VocabularyService.collect/promote/peek` |
| `lite/src/vocabulary/wordbook.ts` | GM Storage 单词本读写、去重、上限 | `readWordbook`、`addWord`、`removeWord`、`isSaved` |
| `lite/src/vocabulary/highlights.ts` | 文本节点级高亮与还原、ink 渐变下划线 | `VocabularyHighlights`、`applyVocabularyInk` |
| `lite/src/vocabulary/word-popup.ts` | 悬浮词卡、声音按钮、朗读 | `showWordPopup`、`soundButton`、`speakWord`、`stopWordSpeech` |
| `lite/src/vocabulary/comment-vocabulary.ts` | 评论正文后的词汇区 | `renderCommentVocabulary` |
| `lite/src/vocabulary/wordbook-panel.ts` | 工作台单词本面板 | `mountWordbookPanel` |

迁移自参考仓库的代码保留 owner 名称与算法（ink 颜色轮转、词卡定位、单词本列表/详情交互），删除 Discourse 与参考仓库的 `TranslationService` / `settings` / `worker` 依赖，替换为 HN Lite 的类型与适配器。

## 5. 数据契约

```ts
// model.ts
export type VocabularyLevel = "CET6" | "CET6+";
export interface VocabularyWord {
  readonly word: string;        // /^[a-z]+(?:[-'][a-z]+)*$/i 且 ≤ 40
  readonly ipa: string;         // ≤ 100
  readonly meaning: string;     // 中文释义，≤ 200
  readonly example: string;     // 原句，≤ 500，必须出现在评论文本中
  readonly exampleMeaning?: string; // 例句译文，≤ 800（按需生成，内存态）
  readonly level: VocabularyLevel;
}
export const VOCABULARY_MAX_WORDS = 6;

// wordbook.ts
export interface SavedWord extends Omit<VocabularyWord, "exampleMeaning"> {
  readonly sourceUrl: string;   // item?id=<commentId>，去 search/hash
  readonly storyTitle: string;  // ≤ 200
  readonly addedAt: number;
}
export const WORDBOOK_STORAGE_KEY = "hn-reader:wordbook:v1";
export const WORDBOOK_MAX_WORDS = 500;
```

缓存身份：`vocabulary:v1:${promptVersion}:${hash(model + sourceHash)}`，值 `{ words: VocabularyWord[] }`，走既有 `IndexedDbCacheStore<CachedVocabulary>`（新库名 `hacker-news-reader-vocabulary`），TTL 沿用 30 天。空结果缓存 60 秒，避免反复请求。

## 6. 设置

```ts
// settings-store.ts 增量
readonly vocabularyEnabled: boolean;      // 默认 false
readonly vocabularyLevels: "cet6" | "cet6plus"; // 默认 "cet6"
```

- 默认关闭：开启即代表用户显式同意向已配置 AI 发送评论原文。
- 设置面板"评论阅读"卡片新增两项：`词汇整理`（开启/关闭）与 `词汇难度`（CET6 及以上 / 仅 CET6+），顺序放在"滚动预翻译"之后。
- `normalizeSettings` 对两个字段做白名单归一；缺失字段回落默认值，不破坏既有存储。
- `SettingsStore.save` 的 AI 校验不因词汇开关而收紧：未配置 AI Key 时仍允许保存，词汇区在请求时显示明确失败文案与重试。

## 7. 运行时接线

### 7.1 评论区宿主

`ReaderView.#renderEntry` 在 `body.append(original, translated, bilingual)` 之后追加词汇区容器：

```ts
const vocabulary = htmlElement(this.document, "div", "hnr-vocabulary");
vocabulary.hidden = true;
row.dataset.vocabularyState = "idle"; // idle | empty | loading | ready | error
```

渲染委托给 `callbacks.renderVocabulary?.(comment.id, vocabulary)`；`ReaderView` 不持有请求、不读缓存、不 import 词汇服务。`applySettings` 关闭词汇时清空并按 `hidden` 收口。

### 7.2 视野编排（`reader-controller.ts`）

- 复用既有 `onRenderedEntries` 回调：记录挂载集合与视口集合（现有 `#viewportCommentIds` 机制）。
- 开关开启且未销毁时，对**视口内**评论调用 `#vocabulary.collect(comment, signal)`；离开视野的评论保留内存结果，不取消已发出的请求。
- 结果到达后只重绘受影响行所在的可见窗口：`this.view.updateVocabulary(id, words)` → `ReaderView` 对 `[data-comment-id]` 命中行重建词汇区并让 `VirtualCommentList` 走既有 ResizeObserver 高度补偿。
- `ReaderScope` 销毁：`AbortController` 取消全部在途词汇任务；`VocabularyHighlights` 依赖行 DOM 被清除自然消失。
- 关闭开关：调用 `view.clearVocabulary()` 清空所有词汇区与高亮，保留缓存（再次开启无需重新请求）。

### 7.3 高亮与还原

`VocabularyHighlights` 迁移后适配：

- 根元素为 `.hnr-original-text`，跳过 `code, pre, script, style, textarea, input, [data-vocabulary-ink]`。
- 高亮按词逐个插入 `<span class="hnr-vocabulary-mark" data-vocabulary-ink>`；`clear()` 用 `mark.replaceWith(document.createTextNode(text))` 完整还原，保证关闭后 DOM 与原文一致。
- 悬浮词卡以 `position: fixed` + Shadow DOM 挂在 Reader shell 内（不是 `document.body`），滚动/resize/Escape/`pointerleave` 关闭；`innerWidth ≤ 700` 或 `(hover: none)` 时不弹卡，仅保留高亮。

### 7.4 单词本面板

- 工作台新增第 5 个标签 `单词本 N`（`ReaderWorkbenchTab` 增 `"wordbook"`），`openReaderWorkbench` 增第 4 个回调参数 `onOpenStory`（由 controller 用现有 `onOpenTopic` 实现跳转）。
- 面板内容：搜索（单词或释义）、排序（最近收藏 / A–Z）、分页（10/20/50）、行内朗读与移除、点击进入详情（大词条、音标、等级、释义、例句、`移除收藏`、`打开收藏来源`）。
- 收藏变更通过 `renderWordbookPanel(root, { onChange, onOpenStory })` 内部重渲染，不引入第二个状态 owner。

## 8. 不变量与性能

- 开关关闭 ⇒ 无词汇请求、无高亮、无词汇区。
- 一条评论最多一次在途请求（task key 去重），最多 6 词，正文截断 3000 字符。
- 不新增 MutationObserver、不轮询、不预取未进入视野的评论。
- 高度变化只经 `VirtualCommentList` 既有测量与 anchor 恢复；词汇区不写测量代码。
- 词汇请求失败不影响翻译、总结、离线下载；错误收敛为词汇区内的可重试文案。
- 缓存与单词本均为本地数据；`onClearCache` 一并清理词汇缓存。`onReset` 只重置设置字段（默认关闭词汇），**不删除**已收藏单词，避免用"恢复默认设置"销毁用户数据。

## 9. 测试计划

| 测试文件 | 覆盖 |
| --- | --- |
| `lite/tests/vocabulary-model.test.ts` | 非法 word、超长字段、等级白名单、6 词上限、`example` 必须出现在原文 |
| `lite/tests/vocabulary-prompt.test.ts` | 版本常量稳定、提示词包含等级与 JSON 契约 |
| `lite/tests/vocabulary-service.test.ts` | 缓存命中不发请求；同 key 去重；空结果 60 秒；解析失败分类；abort 传播（fake http + `MemoryCacheStore`） |
| `lite/tests/vocabulary-wordbook.test.ts` | 增删去重、500 上限、损坏 GM 数据回落空数组、来源 URL 规范化 |
| `lite/tests/vocabulary-highlights.test.ts` | jsdom 高亮插入与 `clear()` 完整还原、跳过 `code/pre`、重复 apply 幂等 |
| `lite/tests/settings-store.test.ts`（增量） | 新字段默认值、归一化、旧存储兼容 |

命令：`npm run hn-lite:lint` → `npm run hn-lite:typecheck` → `npm run hn-lite:test` → `npm run hn-lite:build:local`。浏览器 A/B 验收需用户显式授权后执行。

## 10. 文档同步

- 新增 `docs/adr/0009-ai-vocabulary-in-viewport.md`。
- 更新 `docs/ARCHITECTURE.md`：源码布局增 `vocabulary/`，新增"词汇整理"小节，缓存身份表增词汇与单词本两行，`ReaderScope` 生命周期图增词汇任务。
- 更新 `docs/PRD.md`：功能需求与降级策略各加一条。
- 更新 `docs/REUSE_MATRIX.md`：登记本次复制批次（源文件、目标 owner、删除的依赖、对应测试、证据）。

## 11. 明确排除

- 参考仓库的 `vocabulary-stream.ts`（Responses API SSE）不使用：HN Lite 的 `AiCompletionClient` 在非 `translation:` operation 上走非流式 chat/completions，词汇一次返回。
- 参考仓库的 `translation/combined-vocabulary.ts`（翻译与词汇合包）不使用：两套缓存与优先级独立，避免扩大翻译改动面。
- 参考仓库的 `worker.render/release` 调度器不移植，改由 `VirtualCommentList` 帧事务与 `TranslationTaskManager` 承担。
