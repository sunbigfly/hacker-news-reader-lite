import { AiCompletionClient } from "../ai/ai-completion-client";
import { ManagedAiCompletionClient } from "../ai/managed-ai-completion-client";
import { assertSafeExternalUrl } from "../article/url-policy";
import { CacheRepository } from "../cache/cache-repository";
import { IndexedDbCacheStore } from "../cache/indexeddb-cache-store";
import {
  HnApiAdapter,
  type HnCommentRoot,
  type HnItem,
  type HnReaderTarget,
} from "../hn-api/hn-api-adapter";
import { HnRealtimeAdapter } from "../hn-api/hn-realtime-adapter";
import { parseHnDocument, parseHnStoryPreview } from "../host/hn-dom-adapter";
import { HnPageFetchAdapter } from "../host/hn-page-fetch-adapter";
import type { HnHostThemePort } from "../host/hn-host-theme-controller";
import { LifecycleScope } from "../kernel/lifecycle";
import { GmHttpClient } from "../network/gm-http-client";
import { RequestScheduler } from "../network/request-scheduler";
import {
  buildOfflineHtml,
  downloadOfflineHtml,
  offlineFilename,
} from "../offline/offline-document";
import {
  OfflineHistoryRepository,
  type CachedOfflineDownload,
  type OfflineDownloadHistoryEntry,
  type OfflineDownloadProgress,
} from "../offline/offline-history-repository";
import {
  ReaderView,
  type ReaderCommand,
  type ReaderCommentAction,
  type ReaderWorkbenchTab,
} from "../shell/reader-view";
import { ReaderWorkspace } from "../shell/reader-workspace";
import { sanitizeHtml } from "../security/sanitize-html";
import {
  ReaderWorkspaceStateStore,
  type ReaderTopicHistoryEntry,
  type ReaderTopicPosition,
  type ReaderTopicState,
} from "../settings/reader-workspace-state-store";
import { DEFAULT_SETTINGS, SettingsStore, type ReaderSettings, type ReaderTheme } from "../settings/settings-store";
import {
  SummaryService,
  type CachedSummary,
  type DiscussionSummary,
  type DiscussionSummaryHistoryEntry,
  type DiscussionSummaryScope,
  type SummaryLength,
} from "../summary/summary-service";
import { CommentProjection } from "../thread/comment-projection";
import { CommentTree } from "../thread/comment-tree";
import {
  commentId,
  storyId,
  type Comment,
  type CommentId,
  type StoryId,
  type ThreadSnapshot,
} from "../thread/model";
import { ThreadPreheater } from "../thread/thread-preheater";
import {
  ThreadSnapshotRepository,
  type OptimisticThreadSnapshot,
} from "../thread/thread-snapshot-repository";
import { type TranslationInput, type TranslationOutput } from "../translation/translation-service";
import { TranslationRuntime } from "../translation/translation-runtime";

const OPTIMISTIC_COMMENT_LIMIT = 48;
const TRANSLATION_PREFETCH_LIMIT = 120;
const TRANSLATION_PREFETCH_INTERVAL_MS = 32;
const FIRST_PAINT_FALLBACK_MS = 64;
const COMMENT_PATH_RETRY_DELAY_MS = 350;

type ReaderHnApi = Pick<
  HnApiAdapter,
  "getItem" | "loadCommentSubtrees" | "loadThread" | "toComment" | "toStory"
>;

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Reader 载入已取消");
}

function yieldToFirstPaint(document: Document, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  const view = document.defaultView;
  if (!view) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let firstFrame: number | null = null;
    let secondFrame: number | null = null;
    let timer: number | null = null;
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
      if (firstFrame !== null) view.cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) view.cancelAnimationFrame(secondFrame);
      if (timer !== null) view.clearTimeout(timer);
    };
    const finish = (): void => {
      cleanup();
      resolve();
    };
    const onAbort = (): void => {
      cleanup();
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    timer = view.setTimeout(() => {
      timer = null;
      finish();
    }, FIRST_PAINT_FALLBACK_MS);
    if (typeof view.requestAnimationFrame === "function") {
      firstFrame = view.requestAnimationFrame(() => {
        firstFrame = null;
        secondFrame = view.requestAnimationFrame(() => {
          secondFrame = null;
          finish();
        });
      });
    }
  });
}

function waitForCommentPathRetry(document: Document, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const view = document.defaultView;
    const timer = view?.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, COMMENT_PATH_RETRY_DELAY_MS) ?? null;
    const onAbort = (): void => {
      if (timer !== null) view?.clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

class ReaderSession {
  readonly scope: LifecycleScope;
  readonly scheduler: RequestScheduler;
  readonly hnCacheStore: IndexedDbCacheStore<HnItem>;
  readonly hnCache: CacheRepository<HnItem>;
  readonly summaryCacheStore: IndexedDbCacheStore<CachedSummary>;
  readonly summaryCache: CacheRepository<CachedSummary>;
  readonly summaries: SummaryService;
  readonly offlineCacheStore: IndexedDbCacheStore<CachedOfflineDownload>;
  readonly offlineCache: CacheRepository<CachedOfflineDownload>;
  readonly offlineHistory: OfflineHistoryRepository;
  readonly ai: AiCompletionClient;
  readonly api: ReaderHnApi;
  readonly tree: CommentTree;
  readonly projection: CommentProjection;
  readonly preheater: ThreadPreheater;
  readonly view: ReaderView;
  readonly settingsStore = new SettingsStore();
  readonly translationRuntime: TranslationRuntime;
  readonly #visibleTranslationControllers = new Set<AbortController>();
  readonly #visibleTranslationRequested = new Set<CommentId>();
  #visibleTranslationRun = 0;
  readonly #translationPrefetchControllers = new Set<AbortController>();
  #offlineTranslationController: AbortController | null = null;
  #titleTranslationController: AbortController | null = null;
  #translationPrefetchTimer: number | null = null;
  #queuedTranslationPrefetchIds: readonly CommentId[] = Object.freeze([]);
  readonly #prefetchRequested = new Set<CommentId>();
  readonly #loadingReplies = new Set<CommentId>();
  #replyLoadController: AbortController | null = null;
  readonly #openedAtSecond = Math.floor(Date.now() / 1_000) * 1_000;
  readonly #announcedNewCommentIds = new Set<CommentId>();
  readonly #realtimeChangedParentIds = new Set<number>();
  #realtimeAbortController: AbortController | null = null;
  #realtimeDrainActive = false;
  #realtimeStarted = false;
  #lastDiscussionSummary: DiscussionSummary | null = null;
  #offlineProgress: OfflineDownloadProgress | null = null;
  #offlineHistoryEntries: readonly OfflineDownloadHistoryEntry[] = Object.freeze([]);
  #automaticTitleTranslationStarted = false;
  #viewportTranslationIdentity = "";
  readonly #returnFocus: HTMLElement | null;
  #settings: ReaderSettings;
  #complete: boolean;
  #pendingTopicPosition: ReaderTopicPosition | null;

  constructor(
    readonly document: Document,
    snapshot: ThreadSnapshot,
    storyId: StoryId,
    parentScope: LifecycleScope,
    readonly css: string,
    readonly onClose: () => void,
    readonly onClearThreadCache: () => Promise<void>,
    readonly onThemeChange: (theme: ReaderTheme) => void,
    readonly onSettingsPreview: (settings: ReaderSettings) => void,
    readonly onSettingsChange: (settings: ReaderSettings) => void,
    readonly onHostNavigate: (url: string) => void,
    readonly onStoryTitleChange: (title: string) => void,
    readonly onTopicStateChange: (storyId: StoryId, state: ReaderTopicState) => void,
    readonly onListTopicHistory: () => readonly ReaderTopicHistoryEntry[],
    readonly onOpenTopic: (storyId: StoryId) => void,
    translationRuntime: TranslationRuntime | undefined,
    readonly realtime: HnRealtimeAdapter,
    api: ReaderHnApi | undefined,
    mount: HTMLElement,
    initialTopicState: ReaderTopicState | null,
    source: "preview" | "page" | "cache" = "page",
  ) {
    if (snapshot.story.id !== storyId) throw new Error("当前页面与请求的 HN 故事不一致");
    this.scope = parentScope.child();
    this.#returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.scheduler = new RequestScheduler(4);
    this.hnCacheStore = new IndexedDbCacheStore<HnItem>("hacker-news-reader-hn-items", "cache-v1");
    this.hnCache = new CacheRepository(this.hnCacheStore);
    this.summaryCacheStore = new IndexedDbCacheStore<CachedSummary>("hacker-news-reader-summaries", "cache-v1");
    this.summaryCache = new CacheRepository(this.summaryCacheStore);
    this.offlineCacheStore = new IndexedDbCacheStore<CachedOfflineDownload>("hacker-news-reader-offline-downloads", "cache-v1");
    this.offlineCache = new CacheRepository(this.offlineCacheStore);
    this.offlineHistory = new OfflineHistoryRepository(this.offlineCache);
    const http = new GmHttpClient(this.scheduler);
    this.ai = new AiCompletionClient(http);
    this.api = api ?? new HnApiAdapter(http, this.hnCache);
    this.translationRuntime = translationRuntime ?? new TranslationRuntime(document, this.scope);
    this.summaries = new SummaryService(this.summaryCache, new ManagedAiCompletionClient(this.ai, this.translationRuntime.tasks));
    this.tree = new CommentTree(snapshot.story, snapshot.comments);
    this.onStoryTitleChange(this.tree.story.title);
    this.#settings = this.settingsStore.load();
    this.projection = new CommentProjection(this.tree, this.#settings);
    this.projection.restoreCollapsed(initialTopicState?.collapsedCommentIds ?? []);
    this.projection.restoreReplyWindows(initialTopicState?.replyWindows ?? []);
    this.preheater = new ThreadPreheater(document);
    this.#complete = snapshot.complete;
    this.#pendingTopicPosition = initialTopicState?.position ?? null;
    this.view = new ReaderView(
      document,
      this.tree,
      this.projection,
      this.#complete,
      {
        onClose: () => this.close(),
        onCommand: (command) => { void this.command(command); },
        onCommentAction: (action, id) => { void this.commentAction(action, id); },
        onViewportCommentsChanged: (ids) => {
          queueMicrotask(() => {
            if (this.scope.destroyed) return;
            this.#startAutomaticTranslation(ids);
            this.#queueTranslationPrefetch(this.view.mountedCommentIds());
          });
        },
        onToggleComment: (id) => {
          this.projection.toggle(id);
          this.view.update(this.tree, this.projection, this.#complete);
        },
        onReplyAction: (id, action) => {
          if (action === "expand") this.projection.expandReplies(id);
          else this.projection.collapseReplies(id);
          this.view.update(this.tree, this.projection, this.#complete);
          if (action === "expand") {
            const missing = this.projection.entries().filter((entry) => entry.kind === "missing" && entry.parentId === id);
            void this.#loadReplyItems(missing.map((entry) => entry.id));
          }
        },
        onLoadMissing: (id) => { void this.#loadReplyItems([id]); },
      },
      this.scope,
      css,
      mount,
    );
    this.view.applySettings(this.#settings);
    this.#restorePendingTopicPosition();
    this.#persistTopicState();
    this.onThemeChange(this.#settings.theme);
    this.view.setStatus(
      source === "preview"
        ? "已进入 Reader；正在载入首批评论…"
        : source === "cache"
          ? `已先显示本地快照中的 ${this.tree.size} 条评论；正在展开完整讨论…`
          : `已先显示 ${this.tree.size} 条评论；正在展开完整讨论…`,
      "busy",
    );
    this.scope.add(() => this.scheduler.destroy());
    this.scope.add(() => { void this.hnCacheStore.close(); });
    this.scope.add(() => { void this.summaryCacheStore.close(); });
    this.scope.add(() => { void this.offlineCacheStore.close(); });
    this.scope.add(() => this.preheater.destroy());
    this.scope.add(() => this.#persistTopicState());
    this.scope.add(() => {
      if (this.#translationPrefetchTimer !== null) this.document.defaultView?.clearTimeout(this.#translationPrefetchTimer);
      this.#translationPrefetchTimer = null;
      this.#queuedTranslationPrefetchIds = Object.freeze([]);
      for (const controller of this.#translationPrefetchControllers) controller.abort(new Error("Reader 已关闭"));
      this.#translationPrefetchControllers.clear();
      for (const controller of this.#visibleTranslationControllers) controller.abort(new Error("Reader 已关闭"));
      this.#visibleTranslationControllers.clear();
      this.#visibleTranslationRequested.clear();
      this.#offlineTranslationController?.abort(new Error("Reader 已关闭"));
      this.#offlineTranslationController = null;
      this.#titleTranslationController?.abort(new Error("Reader 已关闭"));
      this.#titleTranslationController = null;
      this.#loadingReplies.clear();
      this.#replyLoadController = null;
      this.#realtimeChangedParentIds.clear();
      this.#realtimeAbortController = null;
    });
    this.#startAutomaticTranslation();
  }

  focus(): void { this.view.focus(); }

  locateComment(id: CommentId, flash = true): boolean {
    return this.view.locateComment(id, flash);
  }

  ingestCommentPath(comments: readonly Comment[]): void {
    const additions = comments.filter((comment) => !this.tree.has(comment.id));
    if (additions.length === 0) return;
    this.tree.ingest(additions);
    this.#complete = this.#complete && this.tree.missingIds().length === 0;
    this.view.update(this.tree, this.projection, this.#complete);
    this.#announceNewComments(additions);
    this.#startAutomaticTranslation();
  }

  reportCommentLookup(id: CommentId): void {
    const message = `最新评论 #${id} 尚未同步，正在从 HN 获取…`;
    this.view.setStatus(message, "busy");
    this.view.setLocatorNotice(message, "busy");
  }

  reportCommentLocated(id: CommentId): void {
    const message = `已定位评论 #${id}。`;
    this.view.setStatus(message, "success");
    this.view.setLocatorNotice(message, "success", 1_800);
  }

  reportCommentNotFound(id: CommentId): void {
    const message = `评论 #${id} 暂未同步，请稍后再次点击。`;
    this.view.setStatus(message, "error");
    this.view.setLocatorNotice(message, "error", 6_000);
  }

  destroy(): void {
    this.scope.destroy();
  }

  close(): void {
    if (this.scope.destroyed) return;
    this.destroy();
    this.onClose();
    queueMicrotask(() => {
      if (this.#returnFocus?.isConnected) this.#returnFocus.focus({ preventScroll: true });
    });
  }

  replaceOptimisticSnapshot(snapshot: ThreadSnapshot, source: "page" | "cache"): void {
    if (this.scope.destroyed) return;
    this.#applySnapshot(snapshot);
    this.view.setStatus(
      source === "cache"
        ? `已先显示本地快照中的 ${this.tree.size} 条评论；正在展开完整讨论…`
        : `已先显示 ${this.tree.size} 条评论；正在展开完整讨论…`,
      "busy",
    );
    this.#startAutomaticTranslation();
  }

  replaceSnapshot(snapshot: ThreadSnapshot, source: "page" | "cache" = "page"): void {
    if (this.scope.destroyed) return;
    this.#applySnapshot(snapshot);
    this.#startPreheat(source === "cache" ? "cache" : "refreshed");
    this.#startAutomaticTranslation();
    if (source === "page") this.#startRealtime();
  }

  #applySnapshot(snapshot: ThreadSnapshot): void {
    const additions = snapshot.comments.filter((comment) => !this.tree.has(comment.id));
    this.tree.replace(snapshot.story, snapshot.comments);
    this.onStoryTitleChange(this.tree.story.title);
    this.#complete = snapshot.complete;
    this.view.update(this.tree, this.projection, this.#complete);
    this.#announceNewComments(additions);
    this.#restorePendingTopicPosition();
  }

  #announceNewComments(comments: readonly Comment[]): void {
    const ids = comments.flatMap((comment) => (
      comment.createdAt !== null
      && comment.createdAt >= this.#openedAtSecond
      && !this.#announcedNewCommentIds.has(comment.id)
        ? [comment.id]
        : []
    ));
    if (ids.length === 0) return;
    for (const id of ids) this.#announcedNewCommentIds.add(id);
    this.view.announceNewComments(ids);
  }

  #startRealtime(): void {
    if (this.#realtimeStarted || this.scope.destroyed) return;
    this.#realtimeStarted = true;
    this.view.setRealtimeState("connecting");
    this.#realtimeAbortController = this.scope.abortController(new Error("Reader 已关闭"));
    const subscribed = this.realtime.subscribe(this.scope, {
      onItemsChanged: (ids) => this.#queueRealtimeChanges(ids),
      onConnected: () => {
        this.view.setRealtimeState("connected");
        this.view.setStatus("HN 实时评论已连接。", "success");
      },
      onReconnecting: () => {
        this.view.setRealtimeState("reconnecting");
        this.view.setStatus("HN 实时连接中断，正在自动重连…", "busy");
      },
      onUnavailable: (reason) => {
        this.view.setRealtimeState("unavailable");
        this.view.setStatus(reason, "error");
      },
    });
    if (!subscribed) {
      this.view.setRealtimeState("unavailable");
      this.#realtimeAbortController.abort(new Error("HN 实时流不可用"));
      this.#realtimeAbortController = null;
    }
  }

  #queueRealtimeChanges(ids: readonly number[]): void {
    if (this.scope.destroyed) return;
    for (const id of ids) {
      if (id === this.tree.story.id) {
        this.#realtimeChangedParentIds.add(id);
        continue;
      }
      try {
        if (this.tree.has(commentId(id))) this.#realtimeChangedParentIds.add(id);
      } catch {
        // Ignore malformed or unrelated global HN update ids.
      }
    }
    if (this.#realtimeChangedParentIds.size > 0) void this.#drainRealtimeChanges();
  }

  async #drainRealtimeChanges(): Promise<void> {
    const signal = this.#realtimeAbortController?.signal;
    if (!signal || signal.aborted || this.#realtimeDrainActive) return;
    this.#realtimeDrainActive = true;
    try {
      while (!signal.aborted && this.#realtimeChangedParentIds.size > 0) {
        const parentIds = [...this.#realtimeChangedParentIds];
        this.#realtimeChangedParentIds.clear();
        await this.#applyRealtimeParentChanges(parentIds, signal);
      }
    } catch (error) {
      if (!signal.aborted) {
        this.view.setStatus(error instanceof Error ? `实时评论同步失败：${error.message}` : "实时评论同步失败", "error");
      }
    } finally {
      this.#realtimeDrainActive = false;
      if (!signal.aborted && this.#realtimeChangedParentIds.size > 0) void this.#drainRealtimeChanges();
    }
  }

  async #applyRealtimeParentChanges(parentIds: readonly number[], signal: AbortSignal): Promise<void> {
    const items = (await Promise.all(parentIds.map(async (id) => {
      try {
        return await this.api.getItem(id, signal, true);
      } catch {
        return null;
      }
    }))).filter((item): item is HnItem => item !== null);
    if (signal.aborted || items.length === 0) return;

    const roots: HnCommentRoot[] = [];
    const updatedComments: Comment[] = [];
    for (const item of items) {
      if (item.id === this.tree.story.id && item.type === "story") {
        const story = this.api.toStory(item, this.document);
        for (const [rank, id] of story.childIds.entries()) {
          if (!this.tree.has(id)) roots.push({ id, parentId: story.id, rank });
        }
        this.tree.updateStory(story);
        continue;
      }
      if (item.type !== "comment") continue;
      const id = commentId(item.id);
      const existing = this.tree.get(id);
      if (!existing) continue;
      const updated = this.api.toComment(item, this.tree.story.id, existing.parentId, existing.rank, this.document);
      updatedComments.push(updated);
      for (const [rank, childId] of updated.childIds.entries()) {
        if (!this.tree.has(childId)) roots.push({ id: childId, parentId: updated.id, rank });
      }
    }
    if (updatedComments.length > 0) this.tree.ingest(updatedComments);

    const uniqueRoots = [...new Map(roots.map((root) => [root.id, root])).values()];
    const additions = uniqueRoots.length > 0
      ? await this.api.loadCommentSubtrees(this.tree.story.id, uniqueRoots, this.document, signal)
      : Object.freeze([] as Comment[]);
    if (signal.aborted) return;
    if (additions.length > 0) this.tree.ingest(additions);
    this.#complete = this.#complete && this.tree.missingIds().length === 0;
    this.view.update(this.tree, this.projection, this.#complete);
    this.#announceNewComments(additions);
    if (additions.length > 0) {
      this.view.setStatus(`已自动同步 ${additions.length} 条新评论。`, "success");
      this.#startAutomaticTranslation();
      this.#startPreheat("refreshed");
    }
  }

  #restorePendingTopicPosition(): void {
    const position = this.#pendingTopicPosition;
    if (position && this.view.restoreTopicPosition(position)) this.#pendingTopicPosition = null;
  }

  #persistTopicState(): void {
    this.onTopicStateChange(this.tree.story.id, {
      schemaVersion: 1,
      position: this.view.captureTopicPosition(),
      collapsedCommentIds: this.projection.collapsedIds(),
      replyWindows: this.projection.replyWindows(),
      storyTitle: this.tree.story.title,
      visitedAt: Date.now(),
    });
  }

  reportLoadFailure(hasCachedSnapshot: boolean): void {
    if (!this.scope.destroyed) {
      this.view.setStatus(
        hasCachedSnapshot
          ? "已保留本地预热快照；HN 后台更新失败，可稍后点刷新补全。"
          : "HN 评论载入失败；已保留 Reader，可稍后点刷新重试。",
        "error",
      );
      this.#startRealtime();
    }
  }

  #startAutomaticTranslation(ids: readonly CommentId[] = this.view.viewportCommentIds()): void {
    if (!this.#settings.translationEnabled || this.scope.destroyed) return;
    if (!this.#automaticTitleTranslationStarted) {
      this.#automaticTitleTranslationStarted = true;
      void this.#translateStoryTitle();
    }
    const identity = ids.join(",");
    if (!identity || identity === this.#viewportTranslationIdentity) return;
    this.#viewportTranslationIdentity = identity;
    void this.translateVisible(ids);
  }

  async command(command: ReaderCommand): Promise<void> {
    if (command === "refresh") await this.refresh();
    else if (command === "translate") await this.#toggleTranslation();
    else if (command === "settings") this.openSettings();
    else if (command === "article") this.openArticle();
    else if (command === "summary") await this.openReaderWorkbench("insight");
    else if (command === "offline") {
      await this.openReaderWorkbench("downloads");
      await this.downloadOffline();
    }
    else if (command === "history") await this.openReaderWorkbench("browsing-history");
  }

  async #toggleTranslation(): Promise<void> {
    const enabled = !this.#settings.translationEnabled;
    const next = { ...this.#settings, translationEnabled: enabled };
    this.settingsStore.save(next);
    this.#settings = next;
    this.view.applySettings(next);
    this.onSettingsChange(next);
    if (!enabled) {
      this.#stopAutomaticTranslation(new Error("自动翻译已关闭"));
      this.view.setStatus("已关闭并持久保存滚动预翻译；现有译文仍保留。", "success");
      return;
    }
    this.view.setStatus("已开启并持久保存滚动预翻译。", "success");
    void this.#translateStoryTitle();
    this.#viewportTranslationIdentity = this.view.viewportCommentIds().join(",");
    await this.translateVisible(this.view.viewportCommentIds(), true);
  }

  async commentAction(action: ReaderCommentAction, id: CommentId): Promise<void> {
    if (action === "copy-link") await this.#copyCommentLink(id);
    else if (action === "translate-comment") await this.#translateComment(id);
    else if (action === "summarize-branch") {
      await this.openReaderWorkbench("insight");
      await this.summarizeDiscussion({ kind: "branch", rootId: id }, "standard");
    }
    else if (action === "reply") this.onHostNavigate(`https://news.ycombinator.com/reply?id=${id}`);
  }

  async #copyCommentLink(id: CommentId): Promise<void> {
    const url = `https://news.ycombinator.com/item?id=${id}`;
    try {
      const clipboard = this.document.defaultView?.navigator.clipboard;
      if (!clipboard) throw new Error("浏览器不支持安全剪贴板 API");
      await clipboard.writeText(url);
      this.view.setStatus(`已复制评论 #${id} 的链接。`, "success");
    } catch (error) {
      this.view.setStatus(error instanceof Error ? error.message : "复制评论链接失败", "error");
    }
  }

  async #translateComment(id: CommentId): Promise<void> {
    const comment = this.tree.get(id);
    if (!comment) {
      this.view.setStatus(`评论 #${id} 不在当前快照中。`, "error");
      return;
    }
    const preheated = this.preheater.get(id);
    const existing = this.view.translationRecords().get(id);
    const refreshing = existing !== undefined;
    this.view.setStatus(`${refreshing ? "正在重新翻译" : "正在翻译"}评论 #${id}…`, "busy");
    const controller = this.scope.abortController(new Error("Reader 已关闭"));
    try {
      const output = (await this.translationRuntime.service.translateMany([{
        id,
        html: preheated?.sanitizedHtml ?? comment.html,
        ...(preheated ? { preheatedSource: preheated.translationText } : {}),
        ...(refreshing ? { forceRefresh: true } : {}),
      }], this.#settings, controller.signal, "interactive", undefined, (result) => {
        if (!refreshing || result.complete) this.#renderTranslation(result);
      }))[0];
      if (!output) {
        this.view.setStatus(`评论 #${id} 无需翻译或文本过短。`, "neutral");
        return;
      }
      this.view.setStatus(`评论 #${id} ${refreshing ? "重新翻译" : "翻译"}完成。`, "success");
    } catch (error) {
      if (!controller.signal.aborted) this.view.setStatus(error instanceof Error ? error.message : "评论翻译失败", "error");
    }
  }

  async refresh(): Promise<void> {
    this.view.setCommandBusy("refresh", true);
    this.view.setStatus("正在从 HN API 补全评论树…", "busy");
    const controller = this.scope.abortController(new Error("Reader 已关闭"));
    try {
      const result = await this.api.loadThread(this.tree.story.id, this.document, controller.signal, (loaded, total) => {
        this.view.setStatus(`正在补全 ${loaded}/${total}…`, "busy");
      });
      const additions = result.comments.filter((comment) => !this.tree.has(comment.id));
      this.tree.updateStory(result.story);
      this.tree.ingest(result.comments);
      this.#complete = true;
      this.view.update(this.tree, this.projection, true);
      this.#announceNewComments(additions);
      if (this.#settings.translationEnabled) void this.#translateStoryTitle();
      this.view.setStatus(`已补全 ${this.tree.size} 条评论。`, "success");
      this.#startPreheat();
    } catch (error) {
      if (!controller.signal.aborted) this.view.setStatus(error instanceof Error ? error.message : "评论补全失败", "error");
    } finally {
      this.view.setCommandBusy("refresh", false);
    }
  }

  async translateVisible(ids: readonly CommentId[] = this.view.viewportCommentIds(), reportEmpty = false): Promise<void> {
    const translated = this.view.translationRecords();
    const promoted: CommentId[] = [];
    const inputs = ids.flatMap((id) => {
      if (translated.has(id) || this.#visibleTranslationRequested.has(id)) return [];
      const comment = this.tree.get(id);
      const preheated = this.preheater.get(id);
      if (!comment || preheated?.needsTranslation === false) return [];
      this.#visibleTranslationRequested.add(id);
      if (this.#prefetchRequested.has(id)) {
        promoted.push(id);
        return [];
      }
      return [{
        id,
        html: preheated?.sanitizedHtml ?? comment.html,
        ...(preheated ? { preheatedSource: preheated.translationText } : {}),
      }];
    });
    if (promoted.length > 0) this.translationRuntime.service.promoteInputs(promoted, "visible");
    if (inputs.length === 0) {
      if (promoted.length > 0) this.view.setStatus(`已优先处理进入视野的 ${promoted.length} 条评论…`, "busy");
      else if (reportEmpty) this.view.setStatus("当前窗口没有可翻译评论。", "neutral");
      return;
    }
    const run = ++this.#visibleTranslationRun;
    this.view.setCommandBusy("translate", true);
    this.view.setStatus(
      promoted.length > 0
        ? `准备翻译当前窗口的 ${inputs.length} 条评论；另有 ${promoted.length} 条已提升优先级…`
        : `准备翻译当前窗口的 ${inputs.length} 条评论…`,
      "busy",
    );
    const controller = this.scope.abortController(new Error("Reader 已关闭"));
    this.#visibleTranslationControllers.add(controller);
    try {
      const outputs = await this.translationRuntime.service.translateMany(inputs, this.#settings, controller.signal, "visible", (complete, total) => {
        if (run === this.#visibleTranslationRun) this.view.setStatus(`翻译进度 ${complete}/${total}…`, "busy");
      }, (output) => this.#renderTranslation(output));
      if (run === this.#visibleTranslationRun) {
        this.view.setStatus(`已翻译 ${outputs.length} 条；无需翻译的短句保持原文。`, "success");
      }
    } catch (error) {
      if (!controller.signal.aborted && run === this.#visibleTranslationRun) {
        this.view.setStatus(error instanceof Error ? error.message : "翻译失败", "error");
      }
    } finally {
      this.#visibleTranslationControllers.delete(controller);
      for (const input of inputs) this.#visibleTranslationRequested.delete(input.id);
      if (run === this.#visibleTranslationRun) {
        this.view.setCommandBusy("translate", false);
        if (this.#settings.translationEnabled) this.#queueTranslationPrefetch(this.view.mountedCommentIds());
      }
    }
  }

  async #loadReplyItems(ids: readonly CommentId[]): Promise<void> {
    if (this.scope.destroyed || ids.length === 0) return;
    this.#replyLoadController ??= this.scope.abortController(new Error("Reader 已关闭"));
    const signal = this.#replyLoadController.signal;
    const entries = this.projection.entries();
    await Promise.all(ids.map(async (id) => {
      if (this.tree.has(id) || this.#loadingReplies.has(id)) return;
      const entry = entries.find((candidate) => candidate.kind === "missing" && candidate.id === id);
      if (!entry || entry.kind !== "missing") return;
      this.#loadingReplies.add(id);
      try {
        const item = await this.api.getItem(id, signal);
        if (signal.aborted || this.tree.has(id)) return;
        if (!item || item.type !== "comment" || item.parent !== entry.parentId) throw new Error("回复暂时不可用，请点击重试。");
        const parent = entry.parentId === this.tree.story.id ? this.tree.story : this.tree.get(entry.parentId as CommentId);
        const rank = parent?.childIds.indexOf(id) ?? -1;
        if (rank < 0) return;
        this.tree.ingest([this.api.toComment(item, this.tree.story.id, entry.parentId, rank, this.document)]);
      } catch (error) {
        if (!signal.aborted) this.view.setStatus(error instanceof Error ? error.message : "回复加载失败，请点击重试。", "error");
      } finally {
        this.#loadingReplies.delete(id);
      }
    }));
    if (signal.aborted) return;
    this.view.update(this.tree, this.projection, this.#complete);
    this.#startPreheat("refreshed");
  }

  openSettings(): void {
    this.view.openSettings(this.#settings, {
      onSave: (settings) => {
        const wasTranslationEnabled = this.#settings.translationEnabled;
        this.settingsStore.save(settings);
        this.#settings = settings;
        this.projection.configure(settings);
        this.view.update(this.tree, this.projection, this.#complete);
        this.view.applySettings(settings);
        this.onThemeChange(settings.theme);
        this.onSettingsChange(settings);
        if (settings.translationEnabled) void this.#translateStoryTitle();
        if (settings.translationEnabled && !wasTranslationEnabled) {
          this.#viewportTranslationIdentity = "";
          this.#startAutomaticTranslation();
        }
        else if (settings.translationEnabled) this.#queueTranslationPrefetch(this.view.mountedCommentIds());
        else {
          this.#stopAutomaticTranslation(new Error("自动翻译已关闭"));
        }
        this.view.setStatus("阅读设置已保存。", "success");
      },
      onLoadModels: (profile) => this.ai.listModels(profile, this.scope.abortController(new Error("Reader 已关闭")).signal),
      onThemePreview: (theme) => this.onThemeChange(theme),
      onSettingsPreview: (settings) => this.onSettingsPreview(settings),
      onClearCache: async () => {
        await Promise.all([
          this.hnCache.clear(),
          this.translationRuntime.cache.clear(),
          this.summaryCache.clear(),
          this.offlineHistory.clear(),
          this.onClearThreadCache(),
        ]);
      },
      onReset: () => {
        this.settingsStore.reset();
        this.#settings = DEFAULT_SETTINGS;
        this.projection.configure(this.#settings);
        this.view.update(this.tree, this.projection, this.#complete);
        this.view.applySettings(this.#settings);
        this.onThemeChange(this.#settings.theme);
        this.onSettingsChange(this.#settings);
        this.#stopAutomaticTranslation(new Error("阅读设置已重置"));
        this.view.setStatus("已恢复默认设置。", "success");
      },
    });
  }

  openArticle(): void {
    if (!this.tree.story.url) {
      this.view.setStatus("当前故事没有外链文章。", "neutral");
      return;
    }
    try {
      const safeUrl = assertSafeExternalUrl(this.tree.story.url).href;
      this.document.defaultView?.open(safeUrl, "_blank", "noopener,noreferrer");
      this.view.setStatus("已在新标签打开原始文章。", "success");
    } catch (error) {
      this.view.setStatus(error instanceof Error ? error.message : "无法打开外链文章", "error");
    }
  }

  async openReaderWorkbench(initialTab: ReaderWorkbenchTab): Promise<void> {
    this.#persistTopicState();
    let summaryHistory: readonly DiscussionSummaryHistoryEntry[] = Object.freeze([]);
    let downloadHistory: readonly OfflineDownloadHistoryEntry[] = Object.freeze([]);
    let topicHistory: readonly ReaderTopicHistoryEntry[] = Object.freeze([]);
    try {
      summaryHistory = await this.summaries.listDiscussionHistory();
    } catch {
      // Summary generation remains available when IndexedDB history cannot be read.
    }
    try {
      downloadHistory = await this.offlineHistory.list();
    } catch {
      // Offline generation remains available when IndexedDB history cannot be read.
    }
    try {
      topicHistory = this.onListTopicHistory();
    } catch {
      // Topic state remains usable when browsing-history enumeration fails.
    }
    if (this.scope.destroyed) return;
    this.#offlineHistoryEntries = downloadHistory;
    const latest = summaryHistory.find((entry) => entry.storyId === this.tree.story.id);
    if (latest) this.#lastDiscussionSummary = latest.summary;
    this.view.openReaderWorkbench(summaryHistory, downloadHistory, topicHistory, {
      onRunSummary: (scope, length) => { void this.summarizeDiscussion(scope, length); },
      onSelectSummary: (entry) => {
        if (entry.storyId === this.tree.story.id) this.#lastDiscussionSummary = entry.summary;
      },
      onDownload: (entry) => { void this.#downloadSavedOffline(entry); },
      onDeleteDownload: (entry) => { void this.#deleteSavedOffline(entry); },
      onOpenTopic: (targetStoryId) => this.onOpenTopic(targetStoryId),
    }, initialTab, latest, this.#offlineProgress);
  }

  async summarizeDiscussion(scope: DiscussionSummaryScope, length: SummaryLength): Promise<void> {
    if (!this.view.readerWorkbenchOpen) await this.openReaderWorkbench("insight");
    this.view.setCommandBusy("summary", true);
    this.view.setSummaryBusy(true);
    this.view.setStatus("正在总结评论树…", "busy");
    const controller = this.scope.abortController(new Error("Reader 已关闭"));
    try {
      const summary = await this.summaries.summarizeDiscussion(
        this.tree.snapshot(this.#complete),
        scope,
        length,
        this.#settings.ai,
        controller.signal,
      );
      this.#lastDiscussionSummary = summary;
      let history: readonly DiscussionSummaryHistoryEntry[] = Object.freeze([]);
      try {
        history = await this.summaries.listDiscussionHistory();
      } catch {
        // Keep the freshly generated summary visible when history storage is unavailable.
      }
      const entry = history[0] ?? Object.freeze({
        id: `session:${Date.now()}`,
        storyId: this.tree.story.id,
        storyTitle: this.tree.story.title,
        scope,
        length,
        model: this.#settings.ai.model,
        savedAt: Date.now(),
        summary,
      });
      this.view.showSummary(entry, history.length > 0 ? history : Object.freeze([entry]));
      this.view.setStatus(`已用 ${this.#settings.ai.model} 总结 ${summary.includedComments}/${summary.availableComments} 条评论。`, "success");
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : "评论总结失败";
        this.view.setStatus(message, "error");
        this.view.setSummaryNotice(message, "error");
      }
    } finally {
      this.view.setCommandBusy("summary", false);
      this.view.setSummaryBusy(false);
    }
  }

  async downloadOffline(): Promise<void> {
    this.#offlineTranslationController?.abort(new Error("已开始新的离线下载"));
    this.#cancelAutomaticCommentTranslations(new Error("正在为离线下载准备全文译文"));
    this.view.setCommandBusy("offline", true);
    const controller = this.scope.abortController(new Error("Reader 已关闭"));
    this.#offlineTranslationController = controller;
    let progress: OfflineDownloadProgress | null = null;
    try {
      const snapshot = this.#safeSnapshot();
      const existing = this.view.translationRecords();
      const commentInputs = snapshot.comments.flatMap((comment) => {
        if (existing.has(comment.id)) return [];
        const preheated = this.preheater.get(comment.id);
        if (preheated?.needsTranslation === false) return [];
        return [{
          id: comment.id,
          html: comment.html,
          ...(preheated ? { preheatedSource: preheated.translationText } : {}),
        }];
      });
      const inputs: readonly TranslationInput[] = [{
        id: snapshot.story.id,
        html: snapshot.story.title,
        translateShortText: true,
      }, ...commentInputs];
      const translationProgress: OfflineDownloadProgress = {
        storyTitle: snapshot.story.title,
        stage: "translating",
        status: "running",
        complete: 0,
        total: inputs.length,
        message: `正在准备标题及 ${commentInputs.length} 条评论的译文。`,
      };
      progress = translationProgress;
      this.#setOfflineProgress(progress);
      let titleTranslation: string | null = null;
      if (inputs.length > 0) {
        this.view.setStatus(`下载前正在准备标题及 ${commentInputs.length} 条评论的译文…`, "busy");
        const outputs = await this.translationRuntime.service.translateMany(inputs, this.#settings, controller.signal, "interactive", (complete, total) => {
          progress = { ...translationProgress, complete, total, message: `译文准备 ${complete}/${total}` };
          this.#setOfflineProgress(progress);
          this.view.setStatus(`下载前译文准备 ${complete}/${total}…`, "busy");
        }, (output) => {
          if (output.id === snapshot.story.id) {
            if (output.text.trim()) this.view.setTitleTranslation(output.text, "", output.complete);
          } else {
            this.#renderTranslation(output);
          }
        });
        titleTranslation = outputs.find((output) => output.id === snapshot.story.id)?.text.trim() || null;
      }
      controller.signal.throwIfAborted();
      const translations = this.view.translationRecords();
      const input = {
        snapshot,
        translations,
        titleTranslation,
        translationMode: this.#settings.translationMode,
        translationTheme: this.#settings.translationTheme,
        fontSettings: {
          titleFontFamily: this.#settings.titleFontFamily,
          titleCustomFontFamily: this.#settings.titleCustomFontFamily,
          fontFamily: this.#settings.fontFamily,
          customFontFamily: this.#settings.customFontFamily,
          fontScale: this.#settings.fontScale,
        },
        readerCss: this.css,
        discussionSummary: this.#lastDiscussionSummary,
      } as const;
      progress = {
        ...progress,
        stage: "generating",
        status: "running",
        complete: progress.total,
        message: `正在生成包含 ${snapshot.comments.length} 条评论的离线 HTML。`,
      };
      this.#setOfflineProgress(progress);
      await yieldToFirstPaint(this.document, controller.signal);
      const html = buildOfflineHtml(input);
      const filename = offlineFilename(input);
      const translatedCount = snapshot.comments.reduce((count, comment) => count + Number(translations.has(comment.id)), 0);
      progress = {
        ...progress,
        stage: "saving",
        message: "HTML 已生成，正在保存到本地下载历史。",
      };
      this.#setOfflineProgress(progress);
      await yieldToFirstPaint(this.document, controller.signal);
      const saved = await this.offlineHistory.save({
        storyId: snapshot.story.id,
        storyTitle: snapshot.story.title,
        filename,
        html,
        commentCount: snapshot.comments.length,
        translatedCount,
      });
      try {
        this.#offlineHistoryEntries = await this.offlineHistory.list();
      } catch {
        this.#offlineHistoryEntries = Object.freeze([saved, ...this.#offlineHistoryEntries.filter((entry) => entry.id !== saved.id)]);
      }
      downloadOfflineHtml(this.document, html, filename);
      progress = {
        ...progress,
        status: "ready",
        message: `已保存 ${snapshot.comments.length} 条评论，其中 ${translatedCount} 条含译文。`,
      };
      this.#setOfflineProgress(progress);
      this.view.setStatus(`全文翻译已完成，离线 HTML 已生成：${snapshot.comments.length} 条评论，${translatedCount} 条含译文。`, "success");
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : "离线文件生成失败";
        if (progress) this.#setOfflineProgress({ ...progress, status: "error", message });
        this.view.setStatus(message, "error");
      }
    } finally {
      if (this.#offlineTranslationController === controller) {
        this.#offlineTranslationController = null;
        this.view.setCommandBusy("offline", false);
        if (this.#settings.translationEnabled) this.#queueTranslationPrefetch(this.view.mountedCommentIds());
      }
    }
  }

  #setOfflineProgress(progress: OfflineDownloadProgress): void {
    this.#offlineProgress = Object.freeze(progress);
    this.view.updateOfflineDownloads(this.#offlineProgress, this.#offlineHistoryEntries);
  }

  async #downloadSavedOffline(entry: OfflineDownloadHistoryEntry): Promise<void> {
    try {
      const html = await this.offlineHistory.getHtml(entry.id);
      if (!html) throw new Error("这份离线 HTML 已过期或已被清理");
      downloadOfflineHtml(this.document, html, entry.filename);
      this.view.setStatus(`已从下载历史重新下载：${entry.filename}`, "success");
    } catch (error) {
      this.view.setStatus(error instanceof Error ? error.message : "历史离线文件下载失败", "error");
    }
  }

  async #deleteSavedOffline(entry: OfflineDownloadHistoryEntry): Promise<void> {
    try {
      const deleted = await this.offlineHistory.delete(entry.id);
      this.#offlineHistoryEntries = await this.offlineHistory.list();
      this.view.updateOfflineDownloads(this.#offlineProgress, this.#offlineHistoryEntries);
      this.view.setStatus(
        deleted ? `已删除下载历史：${entry.filename}` : "这条下载历史已经不存在。",
        deleted ? "success" : "neutral",
      );
    } catch {
      this.view.setStatus("下载历史删除失败，请稍后重试。", "error");
    }
  }

  #startPreheat(source: "local" | "cache" | "refreshed" = "local"): void {
    this.preheater.start(this.tree.snapshot(this.#complete), (complete, total) => {
      if (complete === total) {
        this.view.applyPreheat(this.preheater.values());
        const message = source === "cache"
          ? `已从本地预热快照打开 ${total} 条评论；正在后台检查更新。`
          : source === "refreshed"
            ? `HN 页面已在后台更新：${total} 条评论。`
            : `全帖预热完成：${total} 条评论；未发起网络请求。`;
        if (this.#visibleTranslationControllers.size === 0 && this.#translationPrefetchControllers.size === 0 && !this.#offlineTranslationController) {
          this.view.setStatus(message, "success");
        }
        if (this.#settings.translationEnabled) this.#queueTranslationPrefetch(this.view.mountedCommentIds());
      } else if (complete === 0 && total > 0) {
        if (this.#visibleTranslationControllers.size === 0 && this.#translationPrefetchControllers.size === 0 && !this.#offlineTranslationController) {
          this.view.setStatus(`正在空闲时段预热全帖 ${total} 条评论…`, "busy");
        }
      }
    });
  }

  #queueTranslationPrefetch(ids: readonly CommentId[]): void {
    if (
      !this.#settings.translationEnabled
      || this.scope.destroyed
      || this.#offlineTranslationController
    ) return;
    this.#queuedTranslationPrefetchIds = Object.freeze([
      ...new Set([...this.#queuedTranslationPrefetchIds, ...ids]),
    ]);
    if (this.#translationPrefetchTimer !== null) return;
    this.#translationPrefetchTimer = this.document.defaultView?.setTimeout(() => {
      this.#translationPrefetchTimer = null;
      const candidates = this.#queuedTranslationPrefetchIds;
      this.#queuedTranslationPrefetchIds = Object.freeze([]);
      void this.#prefetchTranslations(candidates);
    }, TRANSLATION_PREFETCH_INTERVAL_MS) ?? null;
  }

  async #translateStoryTitle(): Promise<void> {
    if (!this.#settings.translationEnabled || this.scope.destroyed) return;
    this.#titleTranslationController?.abort(new Error("标题翻译设置已更新"));
    const controller = this.scope.abortController(new Error("Reader 已关闭"));
    this.#titleTranslationController = controller;
    try {
      const output = (await this.translationRuntime.service.translateMany([{
        id: this.tree.story.id,
        html: this.tree.story.title,
        translateShortText: true,
      }], this.#settings, controller.signal, "visible"))[0];
      if (!controller.signal.aborted) this.view.setTitleTranslation(output?.text ?? null);
    } catch {
      // The translated subtitle is additive; the original title remains usable on failure.
    } finally {
      if (this.#titleTranslationController === controller) this.#titleTranslationController = null;
    }
  }

  async #prefetchTranslations(ids: readonly CommentId[]): Promise<void> {
    const translated = this.view.translationRecords();
    const inputs: TranslationInput[] = [];
    for (const id of ids) {
      if (inputs.length >= TRANSLATION_PREFETCH_LIMIT) break;
      if (translated.has(id) || this.#prefetchRequested.has(id) || this.#visibleTranslationRequested.has(id)) continue;
      const comment = this.tree.get(id);
      const preheated = this.preheater.get(id);
      if (!comment || preheated?.needsTranslation === false) continue;
      this.#prefetchRequested.add(id);
      inputs.push({
        id,
        html: preheated?.sanitizedHtml ?? comment.html,
        ...(preheated ? { preheatedSource: preheated.translationText } : {}),
      });
    }
    if (inputs.length === 0) return;
    const controller = this.scope.abortController(new Error("Reader 已关闭"));
    this.#translationPrefetchControllers.add(controller);
    let completed = false;
    try {
      if (this.#visibleTranslationControllers.size === 0) {
        this.view.setStatus(`正在预翻译滚动区域的 ${inputs.length} 条评论…`, "busy");
      }
      let rendered = 0;
      await this.translationRuntime.service.translateMany(
        inputs,
        this.#settings,
        controller.signal,
        "prefetch",
        undefined,
        (output) => {
          this.#renderTranslation(output);
          if (!output.complete) return;
          this.#visibleTranslationRequested.delete(output.id as CommentId);
          rendered += 1;
          if (this.#translationPrefetchControllers.has(controller) && this.#visibleTranslationControllers.size === 0) {
            this.view.setStatus(`滚动预翻译 ${rendered}/${inputs.length}…`, "busy");
          }
        },
      );
      completed = true;
      if (
        this.#visibleTranslationControllers.size === 0
        && this.#translationPrefetchControllers.size === 1
        && this.#translationPrefetchControllers.has(controller)
      ) {
        this.view.setStatus(`已预翻译滚动区域 ${rendered} 条评论。`, "success");
      }
    } catch (error) {
      for (const input of inputs) {
        this.#prefetchRequested.delete(input.id as CommentId);
        this.#visibleTranslationRequested.delete(input.id as CommentId);
      }
      if (
        !controller.signal.aborted
        && this.#translationPrefetchControllers.has(controller)
        && this.#visibleTranslationControllers.size === 0
      ) {
        this.view.setStatus(error instanceof Error ? `滚动预翻译失败：${error.message}` : "滚动预翻译失败", "error");
      }
    } finally {
      this.#translationPrefetchControllers.delete(controller);
      if (completed) this.#queueTranslationPrefetch(this.view.mountedCommentIds());
    }
  }

  #cancelAutomaticCommentTranslations(reason: Error): void {
    this.#cancelTranslationPrefetch(reason);
    this.#viewportTranslationIdentity = "";
    for (const controller of this.#visibleTranslationControllers) controller.abort(reason);
    this.#visibleTranslationControllers.clear();
    this.#visibleTranslationRequested.clear();
    this.view.setCommandBusy("translate", false);
  }

  #cancelTranslationPrefetch(reason: Error): void {
    if (this.#translationPrefetchTimer !== null) this.document.defaultView?.clearTimeout(this.#translationPrefetchTimer);
    this.#translationPrefetchTimer = null;
    this.#queuedTranslationPrefetchIds = Object.freeze([]);
    for (const controller of this.#translationPrefetchControllers) controller.abort(reason);
    this.#translationPrefetchControllers.clear();
    this.#prefetchRequested.clear();
  }

  #stopAutomaticTranslation(reason: Error): void {
    this.#cancelAutomaticCommentTranslations(reason);
    this.#titleTranslationController?.abort(reason);
    this.#titleTranslationController = null;
  }

  #renderTranslation(output: TranslationOutput): void {
    this.view.setTranslation(output.id as CommentId, output.text, output.html, output.bilingualHtml, output.complete);
  }

  #safeSnapshot(): ReturnType<CommentTree["snapshot"]> {
    const snapshot = this.tree.snapshot(this.#complete);
    return {
      ...snapshot,
      comments: Object.freeze(snapshot.comments.map((comment) => ({
        ...comment,
        html: this.preheater.get(comment.id)?.sanitizedHtml
          ?? sanitizeHtml(comment.html, this.document, this.document.baseURI),
      }))),
    };
  }

}

export class ReaderController {
  #session: ReaderSession | null = null;
  #workspace: ReaderWorkspace | null = null;
  #loadingController: AbortController | null = null;
  #pendingCommentTarget: { readonly storyId: StoryId; readonly commentId: CommentId } | null = null;
  readonly #pageScheduler: RequestScheduler;
  readonly #pageFetcher: HnPageFetchAdapter;
  readonly #itemResolver: Pick<HnApiAdapter, "resolveReaderTarget"> & Partial<Pick<HnApiAdapter, "loadCommentPath">>;
  readonly #itemResolverScheduler: RequestScheduler | null;
  #itemResolutionController: AbortController | null = null;
  readonly #threadSnapshots: ThreadSnapshotRepository;
  readonly #theme: HnHostThemePort;
  readonly #yieldToFirstPaint: (signal: AbortSignal) => Promise<void>;
  readonly #onHostNavigate: (url: string) => void;
  readonly #onSettingsPreview: (settings: ReaderSettings) => void;
  readonly #onSettingsChange: (settings: ReaderSettings) => void;
  readonly #onActiveStoryChange: (storyId: StoryId | null) => void;
  readonly #translationRuntime: TranslationRuntime | undefined;
  readonly #realtime: HnRealtimeAdapter;
  readonly #sessionApi: ReaderHnApi | undefined;
  readonly #waitForCommentPathRetry: (signal: AbortSignal) => Promise<void>;
  #hostDocumentTitle: string;
  #readerDocumentTitle: string | null = null;

  constructor(
    readonly document: Document,
    readonly rootScope: LifecycleScope,
    readonly css: string,
    readonly workspaceStateStore = new ReaderWorkspaceStateStore(),
    dependencies: {
      readonly pageFetcher?: HnPageFetchAdapter;
      readonly itemResolver?: Pick<HnApiAdapter, "resolveReaderTarget"> & Partial<Pick<HnApiAdapter, "loadCommentPath">>;
      readonly threadSnapshots?: ThreadSnapshotRepository;
      readonly theme?: HnHostThemePort;
      readonly yieldToFirstPaint?: (signal: AbortSignal) => Promise<void>;
      readonly pageScheduler?: RequestScheduler;
      readonly onHostNavigate?: (url: string) => void;
      readonly onSettingsPreview?: (settings: ReaderSettings) => void;
      readonly onSettingsChange?: (settings: ReaderSettings) => void;
      readonly onActiveStoryChange?: (storyId: StoryId | null) => void;
      readonly translationRuntime?: TranslationRuntime;
      readonly realtime?: HnRealtimeAdapter;
      readonly sessionApi?: ReaderHnApi;
      readonly waitForCommentPathRetry?: (signal: AbortSignal) => Promise<void>;
    } = {},
  ) {
    this.#pageScheduler = dependencies.pageScheduler ?? new RequestScheduler(2);
    this.#pageFetcher = dependencies.pageFetcher
      ?? new HnPageFetchAdapter(document, this.#pageScheduler);
    this.#itemResolverScheduler = dependencies.itemResolver ? null : new RequestScheduler(4);
    this.#itemResolver = dependencies.itemResolver
      ?? new HnApiAdapter(new GmHttpClient(this.#itemResolverScheduler));
    this.#threadSnapshots = dependencies.threadSnapshots ?? new ThreadSnapshotRepository();
    this.#theme = dependencies.theme ?? { apply: () => undefined };
    this.#yieldToFirstPaint = dependencies.yieldToFirstPaint
      ?? ((signal) => yieldToFirstPaint(document, signal));
    this.#onHostNavigate = dependencies.onHostNavigate ?? (() => undefined);
    this.#onSettingsPreview = dependencies.onSettingsPreview ?? (() => undefined);
    this.#onSettingsChange = dependencies.onSettingsChange ?? (() => undefined);
    this.#onActiveStoryChange = dependencies.onActiveStoryChange ?? (() => undefined);
    this.#translationRuntime = dependencies.translationRuntime;
    this.#realtime = dependencies.realtime ?? HnRealtimeAdapter.fromDocument(document);
    this.#sessionApi = dependencies.sessionApi;
    this.#waitForCommentPathRetry = dependencies.waitForCommentPathRetry
      ?? ((signal) => waitForCommentPathRetry(document, signal));
    this.#hostDocumentTitle = document.title;
    rootScope.add(() => this.#pageScheduler.destroy());
    rootScope.add(() => this.#itemResolverScheduler?.destroy());
    rootScope.add(() => this.#itemResolutionController?.abort(new Error("Reader 页面已关闭")));
    rootScope.add(() => { void this.#threadSnapshots.close(); });
    rootScope.add(() => this.#loadingController?.abort(new Error("Reader 页面已关闭")));
    rootScope.add(() => this.#workspace?.destroy());
    rootScope.add(() => this.#onActiveStoryChange(null));
    rootScope.add(() => this.#restoreHostDocumentTitle());
  }

  async openItem(itemId: number): Promise<void> {
    if (!Number.isSafeInteger(itemId) || itemId <= 0) {
      this.#showHostError("HN item id 无效");
      return;
    }
    this.#itemResolutionController?.abort(new Error("已切换到另一个 HN item"));
    this.#itemResolutionController = null;
    const knownTarget = this.#knownReaderTarget(itemId);
    if (knownTarget) {
      await this.open(knownTarget.storyId, knownTarget.commentId);
      return;
    }
    const controller = new AbortController();
    this.#itemResolutionController = controller;
    try {
      const target = await this.#itemResolver.resolveReaderTarget(itemId, controller.signal);
      if (controller.signal.aborted || this.#itemResolutionController !== controller) return;
      this.#itemResolutionController = null;
      await this.open(target.storyId, target.commentId);
    } catch (error) {
      if (!controller.signal.aborted) {
        this.#showHostError(error instanceof Error ? error.message : "HN item 无法定位到讨论");
      }
    } finally {
      if (this.#itemResolutionController === controller) this.#itemResolutionController = null;
    }
  }

  async open(storyId: StoryId, commentId?: CommentId): Promise<void> {
    this.#workspace?.showReader();
    this.#itemResolutionController?.abort(new Error("已直接打开另一篇讨论"));
    this.#itemResolutionController = null;
    this.#pendingCommentTarget = commentId === undefined ? null : { storyId, commentId };
    if (this.#session?.tree.story.id === storyId) {
      this.#onActiveStoryChange(storyId);
      if (commentId === undefined) this.#session.focus();
      else if (this.#loadingController) {
        if (!this.#session.locateComment(commentId, false)) this.#session.reportCommentLookup(commentId);
      }
      else {
        await this.#finishPendingComment(this.#session, storyId);
      }
      return;
    }
    this.#onActiveStoryChange(storyId);
    this.#loadingController?.abort(new Error("已切换到另一篇讨论"));
    this.#session?.destroy();
    this.#session = null;
    this.#restoreHostDocumentTitle();
    const workspace = this.#workspace ?? new ReaderWorkspace(this.document, this.rootScope, {
      readerRatio: this.workspaceStateStore.load().readerRatio,
      onReaderRatioChange: (readerRatio) => this.workspaceStateStore.saveReaderRatio(readerRatio),
    });
    if (!this.#workspace) this.#workspace = workspace;
    workspace.showLoading();
    const controller = new AbortController();
    this.#loadingController = controller;
    let session: ReaderSession | null = null;
    let hasCachedSnapshot = false;
    try {
      if (this.#currentItemMatches(storyId)) {
        const observedAt = Date.now();
        const initial = parseHnDocument(this.document, observedAt, OPTIMISTIC_COMMENT_LIMIT);
        session = this.#mountSession(initial, storyId, workspace, controller, "page");
        this.#revealPendingComment(session);
        await this.#yieldToFirstPaint(controller.signal);
        if (controller.signal.aborted || this.#workspace !== workspace) return;
        const snapshot = parseHnDocument(this.document, observedAt);
        session.replaceSnapshot(snapshot, "page");
        this.#revealPendingComment(session);
        await this.#storeSnapshot(snapshot);
        return;
      }

      const preview = parseHnStoryPreview(this.document, storyId);
      if (preview) {
        session = this.#mountSession(preview, storyId, workspace, controller, "preview");
        this.#revealPendingComment(session);
      }

      const cached = await this.#loadOptimisticSnapshot(storyId);
      if (controller.signal.aborted || this.#workspace !== workspace) return;
      let hasCompleteSnapshot = false;
      if (cached) {
        hasCachedSnapshot = true;
        if (session) session.replaceOptimisticSnapshot(cached.initial, "cache");
        else session = this.#mountSession(cached.initial, storyId, workspace, controller, "cache");
        this.#revealPendingComment(session);
        await this.#yieldToFirstPaint(controller.signal);
        if (controller.signal.aborted || this.#workspace !== workspace) return;
        const completeCached = await cached.complete();
        if (completeCached) {
          session.replaceSnapshot(completeCached, "cache");
          this.#revealPendingComment(session);
          hasCompleteSnapshot = true;
        }
      }

      const fetched = await this.#pageFetcher.load(storyId, controller.signal);
      if (controller.signal.aborted || this.#workspace !== workspace) return;
      const observedAt = Date.now();
      if (!hasCompleteSnapshot) {
        const initial = parseHnDocument(fetched.document, observedAt, OPTIMISTIC_COMMENT_LIMIT);
        if (session) session.replaceOptimisticSnapshot(initial, "page");
        else session = this.#mountSession(initial, storyId, workspace, controller, "page");
        this.#revealPendingComment(session);
        await this.#yieldToFirstPaint(controller.signal);
        if (controller.signal.aborted || this.#workspace !== workspace) return;
      }
      const snapshot = parseHnDocument(fetched.document, observedAt);
      session?.replaceSnapshot(snapshot, "page");
      if (session) this.#revealPendingComment(session);
      await this.#storeSnapshot(snapshot);
    } catch (error) {
      if (!controller.signal.aborted) {
        if (session) session.reportLoadFailure(hasCachedSnapshot);
        else {
          workspace.destroy();
          if (this.#workspace === workspace) this.#workspace = null;
          this.#onActiveStoryChange(null);
          this.#restoreHostDocumentTitle();
          this.#showHostError(error instanceof Error ? error.message : "HN DOM 解析失败");
        }
      }
    } finally {
      if (this.#loadingController === controller) {
        this.#loadingController = null;
        if (!controller.signal.aborted && session) await this.#finishPendingComment(session, storyId);
      }
    }
  }

  close(): void {
    this.#itemResolutionController?.abort(new Error("Reader 已关闭"));
    this.#itemResolutionController = null;
    this.#pendingCommentTarget = null;
    this.#loadingController?.abort(new Error("Reader 已关闭"));
    if (this.#session) this.#session.close();
    else this.#onActiveStoryChange(null);
    this.#restoreHostDocumentTitle();
    this.#workspace?.destroy();
    this.#workspace = null;
  }

  syncHostDocumentTitle(): void {
    if (this.#readerDocumentTitle === null) {
      this.#hostDocumentTitle = this.document.title;
      return;
    }
    if (this.document.title !== this.#readerDocumentTitle) {
      this.#hostDocumentTitle = this.document.title;
    }
    this.document.title = this.#readerDocumentTitle;
  }

  syncHostPageLayout(): void {
    this.#workspace?.syncHostPageLayout();
  }

  #setReaderDocumentTitle(title: string): void {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) return;
    if (this.#readerDocumentTitle === null) this.#hostDocumentTitle = this.document.title;
    this.#readerDocumentTitle = normalizedTitle;
    this.document.title = normalizedTitle;
  }

  #restoreHostDocumentTitle(): void {
    if (this.#readerDocumentTitle === null) return;
    this.#readerDocumentTitle = null;
    this.document.title = this.#hostDocumentTitle;
  }

  #revealPendingComment(session: ReaderSession): void {
    const target = this.#pendingCommentTarget;
    if (!target || target.storyId !== session.tree.story.id) return;
    if (!session.locateComment(target.commentId, false)) session.reportCommentLookup(target.commentId);
  }

  async #finishPendingComment(session: ReaderSession, storyId: StoryId): Promise<void> {
    const target = this.#pendingCommentTarget;
    if (!target || target.storyId !== storyId) return;
    if (session.locateComment(target.commentId, true)) {
      session.reportCommentLocated(target.commentId);
      if (this.#pendingCommentTarget === target) this.#pendingCommentTarget = null;
      return;
    }
    const loadCommentPath = this.#itemResolver.loadCommentPath;
    if (!loadCommentPath) {
      session.reportCommentNotFound(target.commentId);
      if (this.#pendingCommentTarget === target) this.#pendingCommentTarget = null;
      return;
    }
    this.#itemResolutionController?.abort(new Error("已切换到另一条评论"));
    const controller = new AbortController();
    this.#itemResolutionController = controller;
    session.reportCommentLookup(target.commentId);
    try {
      let comments: Awaited<ReturnType<HnApiAdapter["loadCommentPath"]>> | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          comments = await loadCommentPath.call(
            this.#itemResolver,
            target.commentId,
            storyId,
            this.document,
            controller.signal,
          );
          break;
        } catch (error) {
          if (controller.signal.aborted || attempt > 0) throw error;
          await this.#waitForCommentPathRetry(controller.signal);
        }
      }
      if (!comments) throw new Error(`评论 #${target.commentId} 的定位信息不可用`);
      if (controller.signal.aborted || this.#pendingCommentTarget !== target) return;
      session.ingestCommentPath(comments);
      if (session.locateComment(target.commentId, true)) session.reportCommentLocated(target.commentId);
      else session.reportCommentNotFound(target.commentId);
    } catch {
      if (!controller.signal.aborted && this.#pendingCommentTarget === target) {
        session.reportCommentNotFound(target.commentId);
      }
    } finally {
      if (this.#itemResolutionController === controller) this.#itemResolutionController = null;
    }
    if (this.#pendingCommentTarget === target) this.#pendingCommentTarget = null;
  }

  #knownReaderTarget(itemId: number): HnReaderTarget | null {
    if (this.#session?.tree.story.id === itemId) {
      return { storyId: this.#session.tree.story.id };
    }
    try {
      const targetCommentId = commentId(itemId);
      if (this.#session?.tree.get(targetCommentId)) {
        return { storyId: this.#session.tree.story.id, commentId: targetCommentId };
      }
    } catch {
      return null;
    }

    const candidateStoryId = storyId(itemId);
    if (parseHnStoryPreview(this.document, candidateStoryId)) {
      return { storyId: candidateStoryId };
    }

    let currentUrl: URL;
    try {
      currentUrl = new URL(this.document.URL);
    } catch {
      return null;
    }
    if (
      currentUrl.hostname !== "news.ycombinator.com"
      || currentUrl.pathname !== "/item"
      || currentUrl.searchParams.get("id") !== String(itemId)
    ) return null;
    const storyRow = this.document.querySelector<HTMLTableRowElement>("tr.athing:not(.comtr)[id]");
    if (!storyRow?.id) return null;
    let currentStoryId: StoryId;
    try {
      currentStoryId = storyId(storyRow.id);
    } catch {
      return null;
    }
    if (currentStoryId === itemId) return { storyId: currentStoryId };
    const targetComment = this.document.querySelector<HTMLTableRowElement>(
      `tr.athing.comtr[id="${itemId}"]`,
    );
    return targetComment
      ? { storyId: currentStoryId, commentId: commentId(itemId) }
      : null;
  }

  #currentItemMatches(storyId: StoryId): boolean {
    const row = this.document.querySelector<HTMLTableRowElement>("tr.athing:not(.comtr)");
    return row?.id === String(storyId) && this.document.querySelector("table.comment-tree") !== null;
  }

  #mountSession(
    snapshot: ThreadSnapshot,
    storyId: StoryId,
    workspace: ReaderWorkspace,
    loadingController: AbortController,
    source: "preview" | "page" | "cache",
  ): ReaderSession {
    workspace.mount.replaceChildren();
    let initialTopicState: ReaderTopicState | null = null;
    try {
      initialTopicState = this.workspaceStateStore.loadTopicState(storyId);
      if (initialTopicState && this.#pendingCommentTarget?.storyId === storyId) {
        initialTopicState = { ...initialTopicState, position: null };
      }
    } catch {
      // A saved topic state is an enhancement; storage failure must not block Reader mounting.
    }
    const session = new ReaderSession(
      this.document,
      snapshot,
      storyId,
      workspace.scope,
      this.css,
      () => {
        this.#restoreHostDocumentTitle();
        this.#onActiveStoryChange(null);
        if (this.#loadingController === loadingController) {
          loadingController.abort(new Error("Reader 已关闭"));
          this.#loadingController = null;
        }
        if (this.#workspace === workspace) {
          this.#session = null;
          this.#workspace = null;
          workspace.destroy();
        }
      },
      () => this.#threadSnapshots.clear(),
      (theme) => this.#theme.apply(theme),
      this.#onSettingsPreview,
      this.#onSettingsChange,
      this.#onHostNavigate,
      (title) => this.#setReaderDocumentTitle(title),
      (activeStoryId, state) => {
        try {
          this.workspaceStateStore.saveTopicState(activeStoryId, state);
        } catch {
          // Topic-state persistence must not block switching or closing.
        }
      },
      () => this.workspaceStateStore.listTopicHistory(),
      (targetStoryId) => { void this.open(targetStoryId); },
      this.#translationRuntime,
      this.#realtime,
      this.#sessionApi,
      workspace.mount,
      initialTopicState,
      source,
    );
    this.#session = session;
    try {
      this.workspaceStateStore.saveLastActiveStoryId(storyId);
    } catch {
      // Workspace persistence must not block an otherwise usable Reader session.
    }
    return session;
  }

  async #loadOptimisticSnapshot(storyId: StoryId): Promise<OptimisticThreadSnapshot | undefined> {
    try {
      return await this.#threadSnapshots.getOptimistic(storyId, OPTIMISTIC_COMMENT_LIMIT);
    } catch {
      return undefined;
    }
  }

  async #storeSnapshot(snapshot: ThreadSnapshot): Promise<void> {
    try {
      await this.#threadSnapshots.set(snapshot);
    } catch {
      // IndexedDB failure must not block the current in-memory Reader session.
    }
  }

  #showHostError(message: string): void {
    const notice = this.document.createElement("div");
    notice.textContent = `HN Reader：${message}`;
    notice.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:10px 14px;background:#7f1d1d;color:white;border-radius:4px";
    this.document.body.append(notice);
    this.document.defaultView?.setTimeout(() => notice.remove(), 5_000);
  }
}
