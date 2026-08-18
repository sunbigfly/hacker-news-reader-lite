import { htmlElement } from "../dom/html-element";
import { createAuthorAvatarElement } from "../avatar/author-avatar";
import { assertSafeExternalUrl } from "../article/url-policy";
import { applyReaderFontRendering } from "../font/reader-font-rendering";
import { nativeHnItemUrl } from "../host/hn-native-bypass";
import { LifecycleScope } from "../kernel/lifecycle";
import type {
  OfflineDownloadHistoryEntry,
  OfflineDownloadProgress,
} from "../offline/offline-history-repository";
import { sanitizeHtml } from "../security/sanitize-html";
import type { CommentProjection, VisibleEntry } from "../thread/comment-projection";
import type { CommentTree } from "../thread/comment-tree";
import type { CommentId } from "../thread/model";
import type { PreheatedComment } from "../thread/thread-preheater";
import { VirtualCommentList } from "../stream/virtual-comment-list";
import type {
  ReaderTopicHistoryEntry,
  ReaderTopicPosition,
} from "../settings/reader-workspace-state-store";
import type {
  DiscussionSummaryHistoryEntry,
  DiscussionSummaryScope,
  SummaryLength,
} from "../summary/summary-service";
import { READER_TRANSLATION_THEMES, type ReaderTranslationTheme } from "../translation/translation-presentation";
import {
  createBrowserLocalFontQuery,
  LocalFontPicker,
  type LocalFontQuery,
} from "../settings/local-font-picker";
import {
  normalizeSettings,
  readerFontFamilyCss,
  READER_FONT_WEIGHTS,
  type AiProfile,
  type ReaderSettings,
  type ReaderTheme,
  type TranslationDisplayMode,
} from "../settings/settings-store";

export type ReaderCommand = "refresh" | "translate" | "summary" | "offline" | "history" | "article" | "settings";
export type ReaderCommentAction = "copy-link" | "translate-comment" | "summarize-branch" | "reply";
export type ReaderWorkbenchTab = "insight" | "summary-history" | "downloads" | "browsing-history";
export type ReaderRealtimeState = "connecting" | "connected" | "reconnecting" | "unavailable";
const VIEWPORT_TRANSLATION_STABILIZE_MS = 120;
const NEW_COMMENT_HIGHLIGHT_MS = 5_000;
const LOCATED_COMMENT_PIN_MS = 4_000;
const LOCATED_COMMENT_SETTLE_MS = 1_500;
const LOCATED_COMMENT_FLASH_MS = 1_500;
const COLLAPSED_COMMENT_VIEWPORT_INSET_PX = 15;

// Minimal Lucide icon geometry (ISC); kept inline so the userscript does not ship an icon runtime.
const COMMAND_DEFINITIONS: ReadonlyArray<readonly [ReaderCommand, string, readonly string[]]> = [
  ["refresh", "补全评论", ["M21 12a9 9 0 0 0-15.219-6.492L3 8", "M3 3v5h5", "M3 12a9 9 0 0 0 15.219 6.492L21 16", "M16 16h5v5"]],
  ["translate", "开启或关闭自动翻译", ["m5 8 6 6", "m4 14 6-6 2-3", "M2 5h12", "M7 2h1", "m22 22-5-10-5 10", "M14 18h6"]],
  ["summary", "总结讨论", ["M15 12H3", "M17 18H3", "M21 6H3"]],
  ["offline", "下载离线 HTML", ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m7 10 5 5 5-5", "M12 15V3"]],
  ["history", "浏览历史", ["M3 12a9 9 0 1 0 3-6.7", "M3 3v6h6", "M12 7v5l3 2"]],
  ["article", "在新标签打开外链", ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"]],
  ["settings", "阅读设置", ["M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.51a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z", "M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"]],
];

const COMMENT_ACTION_DEFINITIONS: ReadonlyArray<readonly [ReaderCommentAction, string, readonly string[]]> = [
  ["copy-link", "复制评论链接", ["M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71", "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"]],
  ["translate-comment", "翻译此评论", ["m5 8 6 6", "m4 14 6-6 2-3", "M2 5h12", "M7 2h1", "m22 22-5-10-5 10", "M14 18h6"]],
  ["summarize-branch", "总结此分支", ["M15 12H3", "M17 18H3", "M21 6H3"]],
  ["reply", "在 HN 回复", ["m9 17-5-5 5-5", "M4 12h12a4 4 0 0 1 4 4v1"]],
];

function commentActionLabel(action: ReaderCommentAction, label: string, hasTranslation: boolean): string {
  return action === "translate-comment" && hasTranslation ? "重新翻译此评论" : label;
}

const ORIGINAL_ICON_PATHS = ["M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"] as const;
const HEADER_ACTIONS_TOGGLE_ICON_PATHS = ["m15 18-6-6 6-6"] as const;
const HEADER_ACTIONS_COLLAPSE_DELAY_MS = 1_000;
const HEADER_TITLE_MIN_FONT_SIZE_PX = 10;
const HEADER_SUBTITLE_MIN_FONT_SIZE_PX = 9;
const COLLAPSE_ICON_PATHS = ["m17 11-5-5-5 5", "m17 18-5-5-5 5"] as const;
const EXPAND_ICON_PATHS = ["m7 13 5 5 5-5", "m7 6 5 5 5-5"] as const;

function iconElement(document: Document, paths: readonly string[]): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const data of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", data);
    svg.append(path);
  }
  return svg;
}

function tooltipElement(document: Document, label: string, id: string): HTMLElement {
  const tooltip = htmlElement(document, "span", "hnr-tooltip", label);
  tooltip.id = id;
  tooltip.setAttribute("role", "tooltip");
  return tooltip;
}
export interface ReaderViewActions {
  readonly onClose: () => void;
  readonly onCommand: (command: ReaderCommand) => void;
  readonly onCommentAction: (action: ReaderCommentAction, id: CommentId) => void;
  readonly onViewportCommentsChanged: (ids: readonly CommentId[]) => void;
  readonly onToggleComment: (id: CommentId) => void;
  readonly onLoadMissing: (id: CommentId) => void;
}

export class ReaderView {
  readonly #scope: LifecycleScope;
  readonly #host: HTMLDivElement;
  readonly #shadow: ShadowRoot;
  readonly #shell: HTMLElement;
  readonly #titleJump: HTMLAnchorElement;
  readonly #titleJumpTooltip: HTMLElement;
  readonly #titleOriginal: HTMLSpanElement;
  readonly #titleTranslation: HTMLSpanElement;
  readonly #status: HTMLDivElement;
  readonly #locatorNotice: HTMLDivElement;
  readonly #newCommentsNotice: HTMLDivElement;
  readonly #newCommentsLabel: HTMLSpanElement;
  readonly #newCommentsCurrent: HTMLButtonElement;
  readonly #coverage: HTMLSpanElement;
  readonly #commentViewport: HTMLDivElement;
  readonly #virtualList: VirtualCommentList;
  readonly #queryLocalFonts: LocalFontQuery | undefined;
  readonly #translations = new Map<CommentId, { readonly text: string; readonly html: string; readonly bilingualHtml: string; readonly complete: boolean }>();
  #reportedViewportIdentity = "";
  #viewportNotifyTimer: number | null = null;
  #titleFitFrame: number | null = null;
  #titleFitMicrotaskScheduled = false;
  #statusTimer: number | null = null;
  #locatorNoticeTimer: number | null = null;
  readonly #newCommentHighlightIds = new Set<CommentId>();
  readonly #newCommentHighlightTimers = new Map<CommentId, number>();
  readonly #newCommentNoticeIds: CommentId[] = [];
  #newCommentNoticeIndex = 0;
  #locateFlashId: CommentId | null = null;
  #locateFlashTimer: number | null = null;
  #locateFocusFrame: number | null = null;
  #locateFocusGeneration = 0;
  #commentAnchorFrame: number | null = null;
  #commentAnchorGeneration = 0;
  #locatedCommentPinId: CommentId | null = null;
  #locatedCommentPinInsetPx = 0;
  #locatedCommentPinFrame: number | null = null;
  #locatedCommentPinTimer: number | null = null;
  #settingsPreviewRestore: (() => void) | null = null;
  #settingsSurfaceCleanup: (() => void) | null = null;
  #settingsEscapeListener: EventListener | null = null;
  #summarySurface: HTMLElement | null = null;
  #summaryEscapeListener: EventListener | null = null;
  #summaryReturnFocus: HTMLElement | null = null;
  #summaryOnSelect: ((entry: DiscussionSummaryHistoryEntry) => void) | null = null;
  #offlineOnDownload: ((entry: OfflineDownloadHistoryEntry) => void) | null = null;
  #offlineOnDelete: ((entry: OfflineDownloadHistoryEntry) => void) | null = null;
  #summaryActiveId: string | null = null;
  #translationEnabled = false;
  #translationMode: TranslationDisplayMode = "original";
  #focusedCommentId: CommentId | null = null;
  #preheated = new Map<CommentId, PreheatedComment>();
  #visibleEntries: readonly VisibleEntry[] = [];
  #viewportCommentIds: readonly CommentId[] = Object.freeze([]);
  #tree: CommentTree;
  #projection: CommentProjection;

  constructor(
    readonly document: Document,
    tree: CommentTree,
    projection: CommentProjection,
    complete: boolean,
    readonly actions: ReaderViewActions,
    parentScope: LifecycleScope,
    css: string,
    mount: HTMLElement | null = null,
  ) {
    this.#scope = parentScope.child();
    this.#queryLocalFonts = createBrowserLocalFontQuery(document);
    this.#tree = tree;
    this.#projection = projection;
    this.#host = htmlElement(document, "div", "");
    this.#host.id = "hn-reader-root";
    this.#shadow = this.#host.attachShadow({ mode: "open" });
    const style = htmlElement(document, "style");
    style.textContent = css;
    this.#shell = htmlElement(document, "section", "hnr-shell");
    this.#shell.setAttribute("role", "region");
    this.#shell.setAttribute("aria-labelledby", "hnr-reader-title");

    const header = htmlElement(document, "header", "hnr-header");
    const identity = htmlElement(document, "div", "hnr-identity");
    const eyebrow = htmlElement(document, "div", "hnr-eyebrow", "HN READER");
    const title = htmlElement(document, "h1", "hnr-title");
    title.id = "hnr-reader-title";
    this.#titleJump = htmlElement(document, "a", "hnr-title-jump");
    this.#titleJump.href = "#hnr-reader-comments";
    this.#titleJump.dataset.action = "scroll-top";
    this.#titleJump.setAttribute("aria-label", "回到评论顶部");
    this.#titleJumpTooltip = tooltipElement(document, "回到评论顶部", "hnr-tooltip-title-jump");
    this.#titleJump.setAttribute("aria-describedby", this.#titleJumpTooltip.id);
    this.#titleOriginal = htmlElement(document, "span", "hnr-title-original", tree.story.title);
    this.#titleTranslation = htmlElement(document, "span", "hnr-title-subtitle");
    this.#titleTranslation.lang = "zh-CN";
    this.#titleTranslation.hidden = true;
    this.#titleJump.append(this.#titleOriginal, this.#titleTranslation, this.#titleJumpTooltip);
    this.#syncTitleJump(tree);
    title.append(this.#titleJump);
    identity.append(eyebrow, title);
    this.#coverage = htmlElement(document, "span", "hnr-coverage");
    const headerActions = htmlElement(document, "div", "hnr-header-actions");
    headerActions.dataset.expanded = "false";
    let headerActionsCollapseTimer: number | null = null;
    const headerActionsToggle = htmlElement(document, "span", "hnr-actions-toggle");
    headerActionsToggle.setAttribute("aria-hidden", "true");
    headerActionsToggle.append(iconElement(document, HEADER_ACTIONS_TOGGLE_ICON_PATHS));
    const headerActionsContent = htmlElement(document, "div", "hnr-actions-content");
    const commands = htmlElement(document, "nav", "hnr-commands");
    commands.setAttribute("aria-label", "阅读工具");
    for (const [command, label, paths] of COMMAND_DEFINITIONS) {
      const button = htmlElement(document, "button", "hnr-command");
      button.type = "button";
      button.dataset.command = command;
      button.setAttribute("aria-label", label);
      const tooltip = tooltipElement(document, label, `hnr-tooltip-${command}`);
      button.setAttribute("aria-describedby", tooltip.id);
      button.append(iconElement(document, paths), tooltip);
      commands.append(button);
    }
    const close = htmlElement(document, "button", "hnr-close");
    close.type = "button";
    close.dataset.action = "close";
    close.setAttribute("aria-label", "退出阅读");
    const closeTooltip = tooltipElement(document, "退出阅读", "hnr-tooltip-close");
    close.setAttribute("aria-describedby", closeTooltip.id);
    close.append(iconElement(document, ["M6 6l12 12", "M18 6 6 18"]), closeTooltip);
    const original = htmlElement(document, "a", "hnr-original-control");
    original.href = nativeHnItemUrl(tree.story.id);
    original.target = "_blank";
    original.rel = "noopener noreferrer";
    original.setAttribute("aria-label", "回到原帖");
    const originalTooltip = tooltipElement(document, "回到原帖", "hnr-tooltip-original");
    original.setAttribute("aria-describedby", originalTooltip.id);
    original.append(iconElement(document, ORIGINAL_ICON_PATHS), originalTooltip);
    headerActionsContent.append(commands, original, close);
    headerActions.append(headerActionsToggle, headerActionsContent);
    header.append(identity, this.#coverage, headerActions);

    this.#status = htmlElement(document, "div", "hnr-status");
    this.#status.setAttribute("role", "status");
    this.#status.setAttribute("aria-live", "polite");
    this.#locatorNotice = htmlElement(document, "div", "hnr-locator-notice");
    this.#locatorNotice.setAttribute("role", "status");
    this.#locatorNotice.setAttribute("aria-live", "polite");
    this.#locatorNotice.setAttribute("aria-atomic", "true");
    this.#locatorNotice.hidden = true;
    this.#newCommentsNotice = htmlElement(document, "div", "hnr-new-comments-notice");
    this.#newCommentsNotice.setAttribute("role", "status");
    this.#newCommentsNotice.setAttribute("aria-live", "polite");
    this.#newCommentsNotice.setAttribute("aria-atomic", "true");
    this.#newCommentsNotice.hidden = true;
    const previousNewComment = htmlElement(document, "button", "hnr-new-comments-nav");
    previousNewComment.type = "button";
    previousNewComment.dataset.action = "previous-new-comment";
    previousNewComment.setAttribute("aria-label", "上一条新评论");
    const previousNewCommentTooltip = tooltipElement(document, "上一条新评论", "hnr-tooltip-previous-new-comment");
    previousNewComment.setAttribute("aria-describedby", previousNewCommentTooltip.id);
    previousNewComment.append(iconElement(document, ["m15 18-6-6 6-6"]), previousNewCommentTooltip);
    this.#newCommentsCurrent = htmlElement(document, "button", "hnr-new-comments-current");
    this.#newCommentsCurrent.type = "button";
    this.#newCommentsCurrent.dataset.action = "locate-new-comment";
    this.#newCommentsLabel = htmlElement(document, "span", "hnr-new-comments-label");
    const currentNewCommentTooltip = tooltipElement(document, "定位当前新评论", "hnr-tooltip-current-new-comment");
    this.#newCommentsCurrent.setAttribute("aria-describedby", currentNewCommentTooltip.id);
    this.#newCommentsCurrent.append(this.#newCommentsLabel, currentNewCommentTooltip);
    const nextNewComment = htmlElement(document, "button", "hnr-new-comments-nav");
    nextNewComment.type = "button";
    nextNewComment.dataset.action = "next-new-comment";
    nextNewComment.setAttribute("aria-label", "下一条新评论");
    const nextNewCommentTooltip = tooltipElement(document, "下一条新评论", "hnr-tooltip-next-new-comment");
    nextNewComment.setAttribute("aria-describedby", nextNewCommentTooltip.id);
    nextNewComment.append(iconElement(document, ["m9 18 6-6-6-6"]), nextNewCommentTooltip);
    const dismissNewComments = htmlElement(document, "button", "hnr-new-comments-close");
    dismissNewComments.type = "button";
    dismissNewComments.dataset.action = "dismiss-new-comments";
    dismissNewComments.setAttribute("aria-label", "关闭新评论提示");
    const dismissNewCommentsTooltip = tooltipElement(document, "关闭新评论提示", "hnr-tooltip-dismiss-new-comments");
    dismissNewComments.setAttribute("aria-describedby", dismissNewCommentsTooltip.id);
    dismissNewComments.append(iconElement(document, ["M6 6l12 12", "M18 6 6 18"]), dismissNewCommentsTooltip);
    this.#newCommentsNotice.append(previousNewComment, this.#newCommentsCurrent, nextNewComment, dismissNewComments);
    this.#commentViewport = htmlElement(document, "div", "hnr-comments");
    this.#commentViewport.id = "hnr-reader-comments";
    this.#commentViewport.setAttribute("role", "tree");
    this.#commentViewport.setAttribute("aria-label", "Hacker News 评论树");
    this.#commentViewport.tabIndex = 0;
    this.#shell.append(header, this.#status, this.#locatorNotice, this.#commentViewport, this.#newCommentsNotice);
    this.#shadow.append(style, this.#shell);
    (mount ?? document.body).append(this.#host);

    this.#virtualList = new VirtualCommentList(
      this.#commentViewport,
      (entry, index) => this.#renderEntry(entry, index),
      this.#scope,
      undefined,
      (_entries, viewportEntries, notifyViewportChange) => {
        this.#restoreLocatedCommentFlash();
        this.#scheduleLocatedCommentAlignment();
        const viewportRect = this.#commentViewport.getBoundingClientRect();
        const measuredIds = viewportRect.height > 0
          ? [...this.#shadow.querySelectorAll<HTMLElement>(".hnr-comment[data-comment-id]")]
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              return rect.bottom > viewportRect.top && rect.top < viewportRect.bottom;
            })
            .map((element) => Number.parseInt(element.dataset.commentId ?? "", 10) as CommentId)
            .filter((id) => Number.isSafeInteger(id))
          : [];
        const ids = measuredIds.length > 0
          ? measuredIds
          : viewportEntries.filter((entry) => entry.kind === "comment").map((entry) => entry.id);
        this.#viewportCommentIds = Object.freeze(ids);
        this.#startNewCommentHighlightTimers(ids);
        const identity = ids.join(",");
        if (identity === this.#reportedViewportIdentity) {
          if (this.#viewportNotifyTimer !== null) this.document.defaultView?.clearTimeout(this.#viewportNotifyTimer);
          this.#viewportNotifyTimer = null;
          return;
        }
        const report = (): void => {
          if (this.#scope.destroyed || this.#viewportCommentIds.join(",") !== identity) return;
          this.#reportedViewportIdentity = identity;
          this.actions.onViewportCommentsChanged(Object.freeze(ids));
        };
        if (this.#viewportNotifyTimer !== null) this.document.defaultView?.clearTimeout(this.#viewportNotifyTimer);
        this.#viewportNotifyTimer = null;
        if (notifyViewportChange) queueMicrotask(report);
        else this.#viewportNotifyTimer = this.document.defaultView?.setTimeout(() => {
          this.#viewportNotifyTimer = null;
          report();
        }, VIEWPORT_TRANSLATION_STABILIZE_MS) ?? null;
      },
    );
    this.#scope.listen(this.#shadow, "click", (event) => this.#handleClick(event));
    this.#scope.listen(this.#shadow, "keydown", (event) => this.#handleKeydown(event as KeyboardEvent));
    const releaseLocatedCommentPin = (): void => this.#releaseLocatedCommentPin();
    this.#scope.listen(this.#commentViewport, "wheel", releaseLocatedCommentPin, { passive: true });
    this.#scope.listen(this.#commentViewport, "pointerdown", releaseLocatedCommentPin);
    this.#scope.listen(this.#commentViewport, "touchstart", releaseLocatedCommentPin, { passive: true });
    const cancelHeaderActionsCollapse = (): void => {
      if (headerActionsCollapseTimer !== null) this.document.defaultView?.clearTimeout(headerActionsCollapseTimer);
      headerActionsCollapseTimer = null;
    };
    this.#scope.listen(headerActions, "pointerenter", () => {
      cancelHeaderActionsCollapse();
      headerActions.dataset.expanded = "true";
      this.#scheduleHeaderTitleFit();
    });
    this.#scope.listen(headerActions, "pointerleave", () => {
      cancelHeaderActionsCollapse();
      headerActionsCollapseTimer = this.document.defaultView?.setTimeout(() => {
        headerActions.dataset.expanded = "false";
        headerActionsCollapseTimer = null;
        this.#scheduleHeaderTitleFit();
      }, HEADER_ACTIONS_COLLAPSE_DELAY_MS) ?? null;
    });
    this.#scope.listen(headerActions, "focusin", () => this.#scheduleHeaderTitleFit());
    this.#scope.listen(headerActions, "focusout", () => this.#scheduleHeaderTitleFit());
    const view = this.document.defaultView;
    if (view) this.#scope.listen(view, "resize", () => this.#scheduleHeaderTitleFit());
    const ResizeObserverConstructor = view?.ResizeObserver;
    if (ResizeObserverConstructor) {
      this.#scope.observe(
        new ResizeObserverConstructor(() => this.#scheduleHeaderTitleFit()),
        this.#titleJump,
      );
    }
    if (this.document.fonts) {
      this.#scope.listen(this.document.fonts, "loadingdone", () => this.#scheduleHeaderTitleFit());
    }
    this.#scope.listen(this.#shadow, "focusin", (event) => {
      const row = event.composedPath().find((node): node is HTMLElement => node instanceof HTMLElement && node.classList.contains("hnr-comment"));
      if (row?.dataset.commentId) this.#focusedCommentId = Number.parseInt(row.dataset.commentId, 10) as CommentId;
    });
    this.#scope.add(() => this.#host.remove());
    this.#scope.add(() => {
      if (this.#statusTimer !== null) this.document.defaultView?.clearTimeout(this.#statusTimer);
      this.#statusTimer = null;
      if (this.#locatorNoticeTimer !== null) this.document.defaultView?.clearTimeout(this.#locatorNoticeTimer);
      this.#locatorNoticeTimer = null;
      for (const timer of this.#newCommentHighlightTimers.values()) this.document.defaultView?.clearTimeout(timer);
      this.#newCommentHighlightTimers.clear();
      this.#newCommentHighlightIds.clear();
      this.#newCommentNoticeIds.length = 0;
      if (this.#viewportNotifyTimer !== null) this.document.defaultView?.clearTimeout(this.#viewportNotifyTimer);
      this.#viewportNotifyTimer = null;
      if (this.#titleFitFrame !== null) this.document.defaultView?.cancelAnimationFrame(this.#titleFitFrame);
      this.#titleFitFrame = null;
      this.#titleFitMicrotaskScheduled = false;
      cancelHeaderActionsCollapse();
      this.#locateFocusGeneration += 1;
      if (this.#locateFocusFrame !== null) this.document.defaultView?.cancelAnimationFrame(this.#locateFocusFrame);
      this.#locateFocusFrame = null;
      this.#commentAnchorGeneration += 1;
      if (this.#commentAnchorFrame !== null) this.document.defaultView?.cancelAnimationFrame(this.#commentAnchorFrame);
      this.#commentAnchorFrame = null;
      this.#releaseLocatedCommentPin();
      this.#clearLocatedCommentFlash();
      this.#removeSummarySurface(false);
    });
    this.update(tree, projection, complete);
    this.#scheduleHeaderTitleFit();
    queueMicrotask(() => this.#titleJump.focus());
  }

  get mountedCommentCount(): number {
    return this.#virtualList.mountedCount;
  }

  get surfaceRoot(): ShadowRoot {
    return this.#shadow;
  }

  captureTopicPosition(): ReaderTopicPosition | null {
    const position = this.#virtualList.capturePosition();
    return position ? { commentId: position.id, offset: position.offset } : null;
  }

  restoreTopicPosition(position: ReaderTopicPosition): boolean {
    return this.#virtualList.restorePosition({ id: position.commentId, offset: position.offset });
  }

  focus(): void {
    this.#shell.querySelector<HTMLElement>("button, a, [tabindex]")?.focus();
  }

  locateComment(id: CommentId, flash = true): boolean {
    return this.#focusComment(id, flash);
  }

  update(tree: CommentTree, projection: CommentProjection, complete: boolean): void {
    this.#tree = tree;
    this.#projection = projection;
    this.#syncTitleJump(tree);
    if (this.#titleOriginal.textContent !== tree.story.title) {
      this.#titleOriginal.textContent = tree.story.title;
      this.setTitleTranslation(null);
      this.#scheduleHeaderTitleFit();
    }
    const missing = tree.missingIds().length;
    this.#coverage.textContent = `${tree.size} 条评论 · ${complete && missing === 0 ? "完整" : `页面快照${missing > 0 ? ` · 缺 ${missing}` : ""}`}`;
    const entries = projection.entries();
    this.#visibleEntries = entries;
    this.#virtualList.setEntries(
      entries,
      this.#preheated.size > 0 ? entries.map((entry) => this.#preheated.get(entry.id)?.estimatedHeight ?? 112) : undefined,
    );
  }

  setStatus(message: string, tone: "neutral" | "busy" | "success" | "error" = "neutral"): void {
    if (this.#statusTimer !== null) this.document.defaultView?.clearTimeout(this.#statusTimer);
    this.#statusTimer = null;
    this.#status.textContent = message;
    this.#status.dataset.tone = tone;
    this.#status.hidden = message.length === 0;
    if (tone === "success" && message.length > 0) {
      this.#statusTimer = this.document.defaultView?.setTimeout(() => {
        if (this.#status.textContent === message && this.#status.dataset.tone === "success") this.#status.hidden = true;
        this.#statusTimer = null;
      }, 4_000) ?? null;
    }
  }

  setLocatorNotice(
    message: string,
    tone: "busy" | "success" | "error",
    autoHideMs = 0,
  ): void {
    if (this.#locatorNoticeTimer !== null) this.document.defaultView?.clearTimeout(this.#locatorNoticeTimer);
    this.#locatorNoticeTimer = null;
    this.#locatorNotice.textContent = message;
    this.#locatorNotice.dataset.tone = tone;
    this.#locatorNotice.hidden = message.length === 0;
    if (autoHideMs <= 0 || message.length === 0) return;
    this.#locatorNoticeTimer = this.document.defaultView?.setTimeout(() => {
      if (this.#locatorNotice.textContent === message) this.#locatorNotice.hidden = true;
      this.#locatorNoticeTimer = null;
    }, autoHideMs) ?? null;
  }

  setRealtimeState(state: ReaderRealtimeState): void {
    this.#shell.dataset.realtime = state;
    this.#coverage.title = state === "connected"
      ? "HN 实时新评论已连接"
      : state === "connecting"
        ? "正在连接 HN 实时新评论"
        : state === "reconnecting"
          ? "HN 实时连接中断，正在重连"
          : "HN 实时新评论当前不可用";
  }

  announceNewComments(ids: readonly CommentId[]): void {
    const additions = ids.filter((id) => this.#tree.has(id) && !this.#newCommentNoticeIds.includes(id));
    if (additions.length === 0) return;
    const wasEmpty = this.#newCommentNoticeIds.length === 0;
    this.#newCommentNoticeIds.push(...additions);
    for (const id of additions) this.#newCommentHighlightIds.add(id);
    if (wasEmpty) this.#newCommentNoticeIndex = 0;
    for (const row of this.#shadow.querySelectorAll<HTMLElement>(".hnr-comment[data-comment-id]")) {
      const id = Number.parseInt(row.dataset.commentId ?? "", 10) as CommentId;
      if (this.#newCommentHighlightIds.has(id)) row.dataset.newComment = "true";
    }
    this.#renderNewCommentsNotice();
    this.#startNewCommentHighlightTimers(this.#viewportCommentIds);
  }

  setCommandBusy(command: ReaderCommand, busy: boolean): void {
    const button = this.#shadow.querySelector<HTMLButtonElement>(`[data-command="${command}"]`);
    if (!button) return;
    button.disabled = busy;
    button.setAttribute("aria-busy", String(busy));
  }

  setTranslation(id: CommentId, text: string, html = "", bilingualHtml = "", complete = true): void {
    this.#translations.set(id, { text, html, bilingualHtml, complete });
    this.#syncMountedTranslation(id);
  }

  setTranslations(records: readonly { readonly id: CommentId; readonly text: string; readonly html: string; readonly bilingualHtml: string; readonly complete?: boolean }[]): void {
    if (records.length === 0) return;
    for (const record of records) {
      this.#translations.set(record.id, { ...record, complete: record.complete ?? true });
      this.#syncMountedTranslation(record.id);
    }
  }

  setTranslationMode(mode: TranslationDisplayMode): void {
    this.#translationMode = mode;
    for (const id of this.#translations.keys()) this.#syncMountedTranslation(id);
  }

  setTitleTranslation(text: string | null, html = "", complete = true): void {
    const translated = text?.trim() ?? "";
    this.#titleTranslation.dataset.translationComplete = String(complete);
    if (html) this.#titleTranslation.innerHTML = html;
    else this.#titleTranslation.textContent = translated;
    this.#titleTranslation.hidden = !this.#translationEnabled
      || this.#titleTranslation.childNodes.length === 0;
    this.#scheduleHeaderTitleFit();
  }

  discardIncompleteTranslations(ids?: readonly CommentId[]): void {
    const candidates = ids ?? [...this.#translations.keys()];
    for (const id of candidates) {
      const translation = this.#translations.get(id);
      if (!translation || translation.complete) continue;
      this.#translations.delete(id);
      this.#syncMountedTranslation(id);
    }
  }

  setTranslationEnabled(enabled: boolean): void {
    this.#translationEnabled = enabled;
    const button = this.#shadow.querySelector<HTMLButtonElement>('[data-command="translate"]');
    if (button) {
      button.setAttribute("aria-pressed", String(enabled));
      button.dataset.active = String(enabled);
    }
    this.#titleTranslation.hidden = !enabled || this.#titleTranslation.childNodes.length === 0;
    this.#scheduleHeaderTitleFit();
  }

  applySettings(settings: ReaderSettings): void {
    this.#host.dataset.theme = settings.theme;
    const navigator = this.document.defaultView?.navigator;
    applyReaderFontRendering(this.#host, settings.fontRenderingEnabled, {
      userAgent: navigator?.userAgent ?? "",
      platform: navigator?.platform ?? "",
    });
    this.#host.style.setProperty("--hnr-title-font-family", readerFontFamilyCss(settings.titleFontFamily, settings.titleCustomFontFamily));
    this.#host.style.setProperty("--hnr-content-font-family", readerFontFamilyCss(settings.fontFamily, settings.customFontFamily));
    this.#host.style.setProperty("--hnr-content-font-weight", String(settings.fontWeight));
    this.#host.style.setProperty("--hnr-font-scale", String(settings.fontScale));
    this.#host.style.setProperty("--hnr-line-height", String(settings.lineHeight));
    this.#host.dataset.translationTheme = settings.translationTheme;
    this.setTranslationEnabled(settings.translationEnabled);
    this.setTranslationMode(settings.translationMode);
    this.#scheduleHeaderTitleFit();
  }

  #scheduleHeaderTitleFit(): void {
    if (this.#scope.destroyed || this.#titleFitFrame !== null || this.#titleFitMicrotaskScheduled) return;
    const view = this.document.defaultView;
    if (view && typeof view.requestAnimationFrame === "function") {
      this.#titleFitFrame = view.requestAnimationFrame(() => {
        this.#titleFitFrame = null;
        this.#fitHeaderTitle();
      });
      return;
    }
    this.#titleFitMicrotaskScheduled = true;
    queueMicrotask(() => {
      this.#titleFitMicrotaskScheduled = false;
      if (!this.#scope.destroyed) this.#fitHeaderTitle();
    });
  }

  #fitHeaderTitle(): void {
    const availableWidth = this.#titleJump.clientWidth;
    this.#fitHeaderTitleLine(this.#titleOriginal, availableWidth, HEADER_TITLE_MIN_FONT_SIZE_PX);
    if (this.#titleTranslation.hidden) {
      this.#titleTranslation.style.removeProperty("font-size");
      return;
    }
    this.#fitHeaderTitleLine(this.#titleTranslation, availableWidth, HEADER_SUBTITLE_MIN_FONT_SIZE_PX);
  }

  #fitHeaderTitleLine(element: HTMLElement, availableWidth: number, minimumFontSize: number): void {
    element.style.removeProperty("font-size");
    if (availableWidth <= 0 || element.scrollWidth <= availableWidth) return;
    const view = this.document.defaultView;
    const preferredFontSize = Number.parseFloat(view?.getComputedStyle(element).fontSize ?? "");
    if (!Number.isFinite(preferredFontSize) || preferredFontSize <= 0) return;
    const naturalWidth = element.scrollWidth;
    let fittedFontSize = Math.max(
      minimumFontSize,
      Math.floor((preferredFontSize * availableWidth / naturalWidth) * 10) / 10,
    );
    element.style.fontSize = `${fittedFontSize}px`;
    const fittedWidth = element.scrollWidth;
    if (fittedWidth > availableWidth && fittedFontSize > minimumFontSize) {
      fittedFontSize = Math.max(
        minimumFontSize,
        Math.floor((fittedFontSize * availableWidth / fittedWidth) * 10) / 10,
      );
      element.style.fontSize = `${fittedFontSize}px`;
    }
  }

  mountedCommentIds(): readonly CommentId[] {
    return Object.freeze(
      [...this.#shadow.querySelectorAll<HTMLElement>(".hnr-comment[data-comment-id]")]
        .map((element) => Number.parseInt(element.dataset.commentId ?? "", 10) as CommentId)
        .filter((id) => Number.isSafeInteger(id)),
    );
  }

  viewportCommentIds(): readonly CommentId[] {
    return this.#viewportCommentIds;
  }

  visibleCommentIds(): readonly CommentId[] {
    return Object.freeze(this.#projection.entries().filter((entry) => entry.kind === "comment").map((entry) => entry.id));
  }

  translationRecords(): ReadonlyMap<CommentId, { readonly text: string; readonly html: string; readonly bilingualHtml: string }> {
    return new Map([...this.#translations]
      .filter(([, translation]) => translation.complete)
      .map(([id, translation]) => [id, {
        text: translation.text,
        html: translation.html,
        bilingualHtml: translation.bilingualHtml,
      }] as const));
  }

  #syncMountedTranslation(id: CommentId): void {
    const row = this.#shadow.querySelector<HTMLElement>(`.hnr-comment[data-comment-id="${id}"]`);
    if (!row) return;
    const original = row.querySelector<HTMLElement>(".hnr-original-text");
    const translated = row.querySelector<HTMLElement>(".hnr-translated-text");
    const bilingual = row.querySelector<HTMLElement>(".hnr-bilingual-text");
    if (!original || !translated || !bilingual) return;
    const translation = this.#translations.get(id);
    if (translation?.html) translated.innerHTML = translation.html;
    else translated.textContent = translation?.text ?? "";
    if (translation?.bilingualHtml) bilingual.innerHTML = translation.bilingualHtml;
    else bilingual.replaceChildren();
    translated.hidden = !translation || this.#translationMode !== "translated";
    bilingual.hidden = !translation || this.#translationMode !== "bilingual";
    original.hidden = Boolean(translation) && this.#translationMode !== "original";
    const translateAction = row.querySelector<HTMLButtonElement>('[data-comment-action="translate-comment"]');
    if (translateAction) {
      const label = commentActionLabel("translate-comment", "翻译此评论", translation?.complete === true);
      translateAction.setAttribute("aria-label", label);
      const tooltip = translateAction.querySelector<HTMLElement>(".hnr-tooltip");
      if (tooltip) tooltip.textContent = label;
    }
    this.#extendLocatedCommentPin();
  }

  applyPreheat(values: ReadonlyMap<CommentId, PreheatedComment>): void {
    this.#preheated = new Map(values);
    const entries = this.#visibleEntries;
    this.#virtualList.seedHeights(entries.map((entry) => this.#preheated.get(entry.id)?.estimatedHeight ?? 112));
    this.#extendLocatedCommentPin();
  }

  get readerWorkbenchOpen(): boolean {
    return this.#summarySurface !== null;
  }

  openReaderWorkbench(
    summaryHistory: readonly DiscussionSummaryHistoryEntry[],
    downloadHistory: readonly OfflineDownloadHistoryEntry[],
    topicHistory: readonly ReaderTopicHistoryEntry[],
    callbacks: {
      readonly onRunSummary: (scope: DiscussionSummaryScope, length: SummaryLength) => void;
      readonly onSelectSummary: (entry: DiscussionSummaryHistoryEntry) => void;
      readonly onDownload: (entry: OfflineDownloadHistoryEntry) => void;
      readonly onDeleteDownload: (entry: OfflineDownloadHistoryEntry) => void;
      readonly onOpenTopic: (storyId: ReaderTopicHistoryEntry["storyId"]) => void;
    },
    initialTab: ReaderWorkbenchTab,
    initialEntry?: DiscussionSummaryHistoryEntry,
    offlineProgress?: OfflineDownloadProgress | null,
  ): void {
    this.#discardSettingsPreview();
    this.#removeSettingsSurface();
    this.#shadow.querySelector(".hnr-settings-backdrop")?.remove();
    this.#removeSummarySurface(false);
    this.#summaryReturnFocus = this.#shadow.activeElement instanceof HTMLElement
      ? this.#shadow.activeElement
      : this.#shadow.querySelector<HTMLButtonElement>('[data-command="summary"]');
    this.#summaryOnSelect = callbacks.onSelectSummary;
    this.#offlineOnDownload = callbacks.onDownload;
    this.#offlineOnDelete = callbacks.onDeleteDownload;

    const layer = htmlElement(this.document, "div", "hnr-summary-float-layer");
    const surface = htmlElement(this.document, "section", "hnr-summary-window");
    surface.setAttribute("role", "dialog");
    surface.setAttribute("aria-modal", "false");
    surface.setAttribute("aria-labelledby", "hnr-summary-window-title");
    surface.tabIndex = -1;
    const header = htmlElement(this.document, "header", "hnr-summary-window-header");
    const heading = htmlElement(this.document, "div", "hnr-summary-heading");
    heading.append(
      htmlElement(this.document, "span", "hnr-summary-kicker", "LOCAL READING WORKBENCH"),
      htmlElement(this.document, "h2", "", "阅读工作台"),
      htmlElement(this.document, "p", "", this.#tree.story.title),
    );
    const headingTitle = heading.querySelector("h2");
    if (headingTitle) headingTitle.id = "hnr-summary-window-title";
    const close = htmlElement(this.document, "button", "hnr-summary-window-close");
    close.type = "button";
    close.dataset.action = "close-summary";
    close.setAttribute("aria-label", "关闭阅读工作台");
    const closeTooltip = tooltipElement(this.document, "关闭阅读工作台", "hnr-tooltip-workbench-close");
    close.setAttribute("aria-describedby", closeTooltip.id);
    close.append(iconElement(this.document, ["M6 6l12 12", "M18 6 6 18"]), closeTooltip);
    header.append(heading, close);

    const tabs = htmlElement(this.document, "div", "hnr-summary-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "阅读工作台");
    const insightTab = htmlElement(this.document, "button", "hnr-summary-tab", "讨论总结");
    const summaryHistoryTab = htmlElement(this.document, "button", "hnr-summary-tab", `总结历史 ${summaryHistory.length}`);
    const downloadsTab = htmlElement(this.document, "button", "hnr-summary-tab", `下载历史 ${downloadHistory.length}`);
    const browsingHistoryTab = htmlElement(this.document, "button", "hnr-summary-tab", `浏览历史 ${topicHistory.length}`);
    for (const [button, panel] of [
      [insightTab, "insight"],
      [summaryHistoryTab, "summary-history"],
      [downloadsTab, "downloads"],
      [browsingHistoryTab, "browsing-history"],
    ] as const) {
      button.type = "button";
      button.dataset.summaryTab = panel;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(panel === initialTab));
      tabs.append(button);
    }

    const body = htmlElement(this.document, "div", "hnr-summary-window-body");
    const insightPane = htmlElement(this.document, "section", "hnr-summary-pane hnr-summary-insight-pane");
    insightPane.dataset.summaryPane = "insight";
    insightPane.setAttribute("role", "tabpanel");
    const controls = htmlElement(this.document, "form", "hnr-summary-controls");
    const controlsHeading = htmlElement(this.document, "div", "hnr-summary-controls-heading");
    controlsHeading.append(
      htmlElement(this.document, "strong", "", "生成新总结"),
      htmlElement(this.document, "span", "", "确认后才会调用已配置的 AI"),
    );
    const field = (labelText: string, control: HTMLElement): HTMLLabelElement => {
      const label = htmlElement(this.document, "label", "hnr-summary-field");
      label.append(htmlElement(this.document, "span", "", labelText), control);
      return label;
    };
    const scope = htmlElement(this.document, "select");
    scope.name = "scope";
    for (const [value, label, disabled] of [
      ["all", "全部已加载评论", false],
      ["branch", this.#focusedCommentId ? `当前分支 #${this.#focusedCommentId}` : "当前分支（先聚焦一条评论）", !this.#focusedCommentId],
    ] as const) {
      const option = htmlElement(this.document, "option", "", label);
      option.value = value;
      option.disabled = disabled;
      scope.append(option);
    }
    const length = htmlElement(this.document, "select");
    length.name = "length";
    for (const [value, label] of [["short", "精简"], ["standard", "标准"], ["detailed", "详细"]] as const) {
      const option = htmlElement(this.document, "option", "", label);
      option.value = value;
      option.selected = value === "standard";
      length.append(option);
    }
    const run = htmlElement(this.document, "button", "hnr-summary-run", "开始总结");
    run.type = "submit";
    const progress = htmlElement(this.document, "span", "hnr-summary-progress-label", "");
    progress.setAttribute("role", "status");
    progress.setAttribute("aria-live", "polite");
    controls.append(controlsHeading, field("范围", scope), field("长度", length), run, progress);
    const result = htmlElement(this.document, "div", "hnr-summary-result");
    insightPane.append(controls, result);

    const historyPane = htmlElement(this.document, "section", "hnr-summary-pane hnr-summary-history-pane");
    historyPane.dataset.summaryPane = "summary-history";
    historyPane.setAttribute("role", "tabpanel");
    historyPane.hidden = true;
    const downloadsPane = htmlElement(this.document, "section", "hnr-summary-pane hnr-download-pane");
    downloadsPane.dataset.summaryPane = "downloads";
    downloadsPane.setAttribute("role", "tabpanel");
    downloadsPane.hidden = true;
    const browsingHistoryPane = htmlElement(this.document, "section", "hnr-summary-pane hnr-browsing-history-pane");
    browsingHistoryPane.dataset.summaryPane = "browsing-history";
    browsingHistoryPane.setAttribute("role", "tabpanel");
    browsingHistoryPane.hidden = true;
    body.append(insightPane, historyPane, downloadsPane, browsingHistoryPane);
    surface.append(header, tabs, body);
    layer.append(surface);
    this.#shell.append(layer);
    this.#summarySurface = layer;
    const escapeListener: EventListener = (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key !== "Escape" || !layer.isConnected) return;
      keyboardEvent.preventDefault();
      keyboardEvent.stopPropagation();
      this.#removeSummarySurface();
    };
    this.#summaryEscapeListener = escapeListener;
    this.document.addEventListener("keydown", escapeListener, true);
    layer.addEventListener("click", (event) => {
      if (event.target === layer) this.#removeSummarySurface();
    });

    const selectPane = (name: ReaderWorkbenchTab): void => {
      for (const button of tabs.querySelectorAll<HTMLButtonElement>(".hnr-summary-tab")) {
        button.setAttribute("aria-selected", String(button.dataset.summaryTab === name));
      }
      insightPane.hidden = name !== "insight";
      historyPane.hidden = name !== "summary-history";
      downloadsPane.hidden = name !== "downloads";
      browsingHistoryPane.hidden = name !== "browsing-history";
    };
    insightTab.addEventListener("click", () => selectPane("insight"));
    summaryHistoryTab.addEventListener("click", () => selectPane("summary-history"));
    downloadsTab.addEventListener("click", () => selectPane("downloads"));
    browsingHistoryTab.addEventListener("click", () => selectPane("browsing-history"));
    controls.addEventListener("submit", (event) => {
      event.preventDefault();
      const chosenScope: DiscussionSummaryScope = scope.value === "branch" && this.#focusedCommentId
        ? { kind: "branch", rootId: this.#focusedCommentId }
        : { kind: "all" };
      callbacks.onRunSummary(chosenScope, length.value as SummaryLength);
    });
    const selected = initialEntry;
    if (selected) {
      this.#summaryActiveId = selected.id;
      this.#renderSummaryEntry(result, selected);
      callbacks.onSelectSummary(selected);
    } else {
      this.#summaryActiveId = null;
      this.#renderSummaryEmpty(result);
    }
    this.#renderSummaryHistory(historyPane, summaryHistory, selectPane);
    this.#renderOfflineDownloads(downloadsPane, downloadHistory, offlineProgress ?? null);
    this.#renderTopicHistory(browsingHistoryPane, topicHistory, callbacks.onOpenTopic);
    selectPane(initialTab);
    queueMicrotask(() => surface.focus());
  }

  showSummary(
    entry: DiscussionSummaryHistoryEntry,
    history: readonly DiscussionSummaryHistoryEntry[],
  ): void {
    const surface = this.#summarySurface;
    if (!surface) return;
    const result = surface.querySelector<HTMLDivElement>(".hnr-summary-result");
    const historyPane = surface.querySelector<HTMLElement>(".hnr-summary-history-pane");
    if (!result || !historyPane) return;
    this.#summaryActiveId = entry.id;
    this.#renderSummaryEntry(result, entry);
    this.#renderSummaryHistory(historyPane, history, (name) => {
      for (const button of surface.querySelectorAll<HTMLButtonElement>(".hnr-summary-tab")) {
        button.setAttribute("aria-selected", String(button.dataset.summaryTab === name));
      }
      for (const pane of surface.querySelectorAll<HTMLElement>(".hnr-summary-pane")) {
        pane.hidden = pane.dataset.summaryPane !== name;
      }
    });
    const historyTab = surface.querySelector<HTMLButtonElement>('[data-summary-tab="summary-history"]');
    if (historyTab) historyTab.textContent = `总结历史 ${history.length}`;
    this.setSummaryBusy(false);
  }

  updateOfflineDownloads(
    progress: OfflineDownloadProgress | null,
    history: readonly OfflineDownloadHistoryEntry[],
  ): void {
    const surface = this.#summarySurface;
    if (!surface) return;
    const pane = surface.querySelector<HTMLElement>(".hnr-download-pane");
    if (!pane) return;
    this.#renderOfflineDownloads(pane, history, progress);
    const historyTab = surface.querySelector<HTMLButtonElement>('[data-summary-tab="downloads"]');
    if (historyTab) historyTab.textContent = `下载历史 ${history.length}`;
  }

  setSummaryBusy(busy: boolean): void {
    const surface = this.#summarySurface;
    if (!surface) return;
    surface.querySelector<HTMLElement>(".hnr-summary-window")?.setAttribute("aria-busy", String(busy));
    for (const control of surface.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(".hnr-summary-controls button, .hnr-summary-controls select")) {
      control.disabled = busy;
    }
    const label = surface.querySelector<HTMLElement>(".hnr-summary-progress-label");
    if (label && busy) {
      label.dataset.tone = "busy";
      label.textContent = "正在理解评论树…";
    } else if (label?.dataset.tone === "busy") {
      label.dataset.tone = "neutral";
      label.textContent = "";
    }
  }

  setSummaryNotice(message: string, tone: "neutral" | "error" = "neutral"): void {
    const label = this.#summarySurface?.querySelector<HTMLElement>(".hnr-summary-progress-label");
    if (!label) return;
    label.dataset.tone = tone;
    label.textContent = message;
  }

  #renderSummaryEmpty(container: HTMLElement): void {
    container.replaceChildren();
    const empty = htmlElement(this.document, "div", "hnr-summary-empty");
    empty.append(
      htmlElement(this.document, "span", "hnr-summary-empty-mark", "01"),
      htmlElement(this.document, "h3", "", "还没有讨论摘要"),
      htmlElement(this.document, "p", "", "选择总结范围与长度，开始后会在这里生成覆盖率、共识、分歧和关键分支。"),
    );
    container.append(empty);
  }

  #renderSummaryEntry(container: HTMLElement, entry: DiscussionSummaryHistoryEntry): void {
    container.replaceChildren();
    const headingStory = this.#summarySurface?.querySelector<HTMLElement>(".hnr-summary-heading p");
    if (headingStory) headingStory.textContent = entry.storyTitle;
    const { summary } = entry;
    const available = Math.max(0, summary.availableComments);
    const included = Math.max(0, Math.min(summary.includedComments, available));
    const coverage = available > 0 ? Math.round((included / available) * 100) : 0;
    const dashboard = htmlElement(this.document, "div", "hnr-summary-dashboard");
    const coverageCard = htmlElement(this.document, "section", "hnr-summary-coverage-card");
    const ring = htmlElement(this.document, "div", "hnr-summary-coverage-ring");
    ring.style.setProperty("--hnr-summary-coverage", `${coverage}%`);
    ring.setAttribute("role", "img");
    ring.setAttribute("aria-label", `总结覆盖 ${included}/${available} 条评论，${coverage}%`);
    ring.append(
      htmlElement(this.document, "strong", "", `${coverage}%`),
      htmlElement(this.document, "span", "", "覆盖率"),
    );
    const coverageCopy = htmlElement(this.document, "div", "hnr-summary-coverage-copy");
    coverageCopy.append(
      htmlElement(this.document, "span", "hnr-summary-overline", "COMMENT COVERAGE"),
      htmlElement(this.document, "strong", "", `${included} / ${available} 条评论`),
      htmlElement(this.document, "p", "", summary.coverageNote),
    );
    coverageCard.append(ring, coverageCopy);
    const metrics = htmlElement(this.document, "div", "hnr-summary-metrics");
    for (const [value, label, tone] of [
      [summary.consensus.length, "共识", "consensus"],
      [summary.disputes.length, "分歧", "disputes"],
      [summary.branches.length, "关键分支", "branches"],
    ] as const) {
      const metric = htmlElement(this.document, "div", "hnr-summary-metric");
      metric.dataset.tone = tone;
      metric.append(
        htmlElement(this.document, "strong", "", String(value)),
        htmlElement(this.document, "span", "", label),
      );
      metrics.append(metric);
    }
    dashboard.append(coverageCard, metrics);

    const overview = htmlElement(this.document, "section", "hnr-summary-overview");
    overview.append(
      htmlElement(this.document, "span", "hnr-summary-section-index", "01 / OVERVIEW"),
      htmlElement(this.document, "h3", "", "讨论全景"),
      htmlElement(this.document, "p", "", summary.overview),
    );
    const signals = htmlElement(this.document, "div", "hnr-summary-signal-grid");
    signals.append(
      this.#summaryList("共识", "反复出现的一致观点", summary.consensus, "consensus"),
      this.#summaryList("分歧", "仍在交锋的关键判断", summary.disputes, "disputes"),
    );
    container.append(dashboard, overview, signals);
    if (summary.branches.length > 0) {
      const branches = htmlElement(this.document, "section", "hnr-summary-branches");
      const branchHeading = htmlElement(this.document, "div", "hnr-summary-section-heading");
      branchHeading.append(
        htmlElement(this.document, "span", "hnr-summary-section-index", "04 / BRANCHES"),
        htmlElement(this.document, "h3", "", "关键分支"),
      );
      branches.append(branchHeading);
      for (const branch of summary.branches) {
        const control = entry.storyId === this.#tree.story.id
          ? htmlElement(this.document, "button", "hnr-summary-branch")
          : htmlElement(this.document, "a", "hnr-summary-branch");
        if (control instanceof HTMLButtonElement) {
          control.type = "button";
          control.dataset.action = "locate-summary-comment";
          control.dataset.commentId = String(branch.commentId);
        } else {
          control.href = `https://news.ycombinator.com/item?id=${branch.commentId}`;
          control.target = "_blank";
          control.rel = "noopener noreferrer";
          control.setAttribute("aria-label", `在新标签打开历史总结中的评论 #${branch.commentId}`);
        }
        control.append(
          htmlElement(this.document, "span", "hnr-summary-branch-id", `#${branch.commentId}`),
          htmlElement(this.document, "span", "", branch.summary),
          iconElement(this.document, ["M5 12h14", "m13 6 6 6-6 6"]),
        );
        branches.append(control);
      }
      container.append(branches);
    }
    const meta = htmlElement(this.document, "footer", "hnr-summary-meta");
    meta.append(
      htmlElement(this.document, "span", "", this.#summaryScopeLabel(entry.scope)),
      htmlElement(this.document, "span", "", this.#summaryLengthLabel(entry.length)),
      htmlElement(this.document, "span", "", entry.model || "未标记模型"),
      htmlElement(this.document, "time", "", this.#summaryTime(entry.savedAt)),
    );
    container.append(meta);
  }

  #summaryList(
    title: string,
    description: string,
    items: readonly string[],
    tone: "consensus" | "disputes",
  ): HTMLElement {
    const section = htmlElement(this.document, "section", "hnr-summary-signal");
    section.dataset.tone = tone;
    section.append(
      htmlElement(this.document, "span", "hnr-summary-section-index", tone === "consensus" ? "02 / SIGNAL" : "03 / TENSION"),
      htmlElement(this.document, "h3", "", title),
      htmlElement(this.document, "p", "hnr-summary-signal-description", description),
    );
    if (items.length === 0) {
      section.append(htmlElement(this.document, "p", "hnr-summary-none", "本次总结未提取到此类信号。"));
      return section;
    }
    const list = htmlElement(this.document, "ol");
    for (const item of items) list.append(htmlElement(this.document, "li", "", item));
    section.append(list);
    return section;
  }

  #renderSummaryHistory(
    container: HTMLElement,
    history: readonly DiscussionSummaryHistoryEntry[],
    selectPane: (name: ReaderWorkbenchTab) => void,
  ): void {
    container.replaceChildren();
    const heading = htmlElement(this.document, "div", "hnr-summary-history-heading");
    heading.append(
      htmlElement(this.document, "span", "hnr-summary-section-index", "ARCHIVE / 30 DAYS"),
      htmlElement(this.document, "h3", "", "全部讨论总结历史"),
      htmlElement(this.document, "p", "", "汇总所有帖子近 30 天的讨论总结，按最近使用排列并自动去重。"),
    );
    container.append(heading);
    if (history.length === 0) {
      container.append(htmlElement(this.document, "p", "hnr-summary-history-empty", "生成第一份总结后，记录会出现在这里。"));
      return;
    }
    const list = htmlElement(this.document, "div", "hnr-summary-history-list");
    for (const [index, entry] of history.entries()) {
      const button = htmlElement(this.document, "button", "hnr-summary-history-entry");
      button.type = "button";
      button.dataset.active = String(entry.id === this.#summaryActiveId);
      button.append(
        htmlElement(this.document, "span", "hnr-summary-history-number", String(index + 1).padStart(2, "0")),
        htmlElement(this.document, "strong", "hnr-summary-history-story", entry.storyTitle),
        htmlElement(this.document, "span", "hnr-summary-history-overview", entry.summary.overview),
      );
      const metadata = htmlElement(this.document, "span", "hnr-summary-history-meta");
      metadata.append(
        htmlElement(this.document, "span", "", this.#summaryScopeLabel(entry.scope)),
        htmlElement(this.document, "span", "", this.#summaryLengthLabel(entry.length)),
        htmlElement(this.document, "span", "", `${entry.summary.includedComments}/${entry.summary.availableComments} 条`),
        htmlElement(this.document, "time", "", this.#summaryTime(entry.savedAt)),
      );
      button.append(metadata);
      button.addEventListener("click", () => {
        const result = this.#summarySurface?.querySelector<HTMLElement>(".hnr-summary-result");
        if (!result) return;
        this.#summaryActiveId = entry.id;
        this.#renderSummaryEntry(result, entry);
        this.#summaryOnSelect?.(entry);
        selectPane("insight");
        for (const candidate of list.querySelectorAll<HTMLElement>(".hnr-summary-history-entry")) {
          candidate.dataset.active = String(candidate === button);
        }
      });
      list.append(button);
    }
    container.append(list);
  }

  #renderTopicHistory(
    container: HTMLElement,
    history: readonly ReaderTopicHistoryEntry[],
    onOpenTopic: (storyId: ReaderTopicHistoryEntry["storyId"]) => void,
  ): void {
    container.replaceChildren();
    const heading = htmlElement(this.document, "div", "hnr-summary-history-heading");
    heading.append(
      htmlElement(this.document, "span", "hnr-summary-section-index", "LOCAL / READING TRAIL"),
      htmlElement(this.document, "h3", "", "浏览历史"),
      htmlElement(this.document, "p", "", "按最近浏览排列；返回 Topic 时同步恢复回复树收纳状态和离开位置。"),
    );
    container.append(heading);
    if (history.length === 0) {
      container.append(htmlElement(this.document, "p", "hnr-summary-history-empty", "打开第一篇 Topic 后，浏览记录会出现在这里。"));
      return;
    }
    const search = htmlElement(this.document, "input", "hnr-browsing-history-search");
    search.type = "search";
    search.placeholder = "搜索标题、Topic ID 或评论 ID";
    search.setAttribute("aria-label", "搜索浏览历史");
    const list = htmlElement(this.document, "div", "hnr-browsing-history-list");
    const rows: Array<{ readonly button: HTMLButtonElement; readonly identity: string }> = [];
    for (const [index, entry] of history.entries()) {
      const button = htmlElement(this.document, "button", "hnr-browsing-history-entry");
      button.type = "button";
      button.dataset.storyId = String(entry.storyId);
      button.dataset.active = String(entry.storyId === this.#tree.story.id);
      button.append(
        htmlElement(this.document, "span", "hnr-summary-history-number", String(index + 1).padStart(2, "0")),
        htmlElement(this.document, "strong", "hnr-browsing-history-story", entry.storyTitle),
      );
      const metadata = htmlElement(this.document, "span", "hnr-browsing-history-meta");
      metadata.append(
        htmlElement(this.document, "span", "", `Topic #${entry.storyId}`),
        htmlElement(this.document, "time", "", entry.visitedAt > 0 ? this.#summaryTime(entry.visitedAt) : "较早记录"),
      );
      if (entry.position) metadata.append(htmlElement(this.document, "span", "", `评论 #${entry.position.commentId}`));
      if (entry.collapsedCommentCount > 0) metadata.append(htmlElement(this.document, "span", "", `收纳 ${entry.collapsedCommentCount} 个分支`));
      button.append(metadata);
      button.addEventListener("click", () => onOpenTopic(entry.storyId));
      rows.push({
        button,
        identity: `${entry.storyTitle} ${entry.storyId} ${entry.position?.commentId ?? ""}`.toLocaleLowerCase(),
      });
      list.append(button);
    }
    const filter = (): void => {
      const query = search.value.trim().toLocaleLowerCase();
      for (const row of rows) row.button.hidden = query.length > 0 && !row.identity.includes(query);
    };
    search.addEventListener("input", filter);
    container.append(search, list);
  }

  #renderOfflineDownloads(
    container: HTMLElement,
    history: readonly OfflineDownloadHistoryEntry[],
    progress: OfflineDownloadProgress | null,
  ): void {
    container.replaceChildren();
    const heading = htmlElement(this.document, "div", "hnr-summary-history-heading");
    heading.append(
      htmlElement(this.document, "span", "hnr-summary-section-index", "OFFLINE / LOCAL ONLY"),
      htmlElement(this.document, "h3", "", "离线 HTML"),
      htmlElement(this.document, "p", "", "可视化准备译文、生成 HTML 和本地保存；完成记录保留 30 天。"),
    );
    container.append(heading);

    if (progress) {
      const card = htmlElement(this.document, "section", "hnr-download-progress");
      card.dataset.status = progress.status;
      const copy = htmlElement(this.document, "div", "hnr-download-progress-copy");
      copy.append(
        htmlElement(this.document, "span", "hnr-summary-section-index", progress.status === "ready" ? "READY" : progress.status === "error" ? "INTERRUPTED" : "IN PROGRESS"),
        htmlElement(this.document, "strong", "", progress.storyTitle),
        htmlElement(this.document, "p", "", progress.message),
      );
      const stageIndex = ["translating", "generating", "saving"].indexOf(progress.stage);
      const stages = htmlElement(this.document, "ol", "hnr-download-stages");
      for (const [index, [stage, label, description]] of [
        ["translating", "准备译文", progress.total > 0 ? `${progress.complete}/${progress.total}` : "检查本地译文"],
        ["generating", "生成 HTML", "组装安全的离线文档"],
        ["saving", "保存记录", "写入本地历史并下载"],
      ].entries()) {
        const item = htmlElement(this.document, "li", "hnr-download-stage");
        const state = progress.status === "ready"
          ? "done"
          : index < stageIndex
            ? "done"
            : index === stageIndex
              ? progress.status === "error" ? "error" : "active"
              : "pending";
        item.dataset.state = state;
        item.dataset.stage = stage;
        item.append(
          htmlElement(this.document, "span", "hnr-download-stage-mark", state === "done" ? "✓" : String(index + 1).padStart(2, "0")),
          htmlElement(this.document, "strong", "", label),
          htmlElement(this.document, "span", "", description),
        );
        if (stage === "translating" && progress.total > 0) {
          const ratio = Math.max(0, Math.min(1, progress.complete / progress.total));
          const meter = htmlElement(this.document, "span", "hnr-download-meter");
          meter.setAttribute("role", "progressbar");
          meter.setAttribute("aria-label", "离线译文准备进度");
          meter.setAttribute("aria-valuemin", "0");
          meter.setAttribute("aria-valuemax", String(progress.total));
          meter.setAttribute("aria-valuenow", String(progress.complete));
          meter.style.setProperty("--hnr-download-progress", `${Math.round(ratio * 100)}%`);
          item.append(meter);
        }
        stages.append(item);
      }
      card.append(copy, stages);
      container.append(card);
    } else {
      const empty = htmlElement(this.document, "div", "hnr-download-idle");
      empty.append(
        htmlElement(this.document, "strong", "", "当前没有下载任务"),
        htmlElement(this.document, "span", "", "点击阅读器顶部的下载按钮，会在这里显示翻译与 HTML 生成进度。"),
      );
      container.append(empty);
    }

    const archiveHeading = htmlElement(this.document, "div", "hnr-download-history-heading");
    archiveHeading.append(
      htmlElement(this.document, "strong", "", `全部下载历史 · ${history.length}`),
      htmlElement(this.document, "span", "", "跨帖子保存已完成的 HTML，可随时再次下载。"),
    );
    container.append(archiveHeading);
    if (history.length === 0) {
      container.append(htmlElement(this.document, "p", "hnr-summary-history-empty", "首个离线 HTML 完成后，文件会保存在这里。"));
      return;
    }
    const list = htmlElement(this.document, "div", "hnr-download-history-list");
    for (const [index, entry] of history.entries()) {
      const item = htmlElement(this.document, "article", "hnr-download-history-entry");
      const detail = htmlElement(this.document, "div", "hnr-download-history-detail");
      detail.append(
        htmlElement(this.document, "strong", "", entry.storyTitle),
        htmlElement(this.document, "span", "", entry.filename),
      );
      const meta = htmlElement(this.document, "div", "hnr-download-history-meta");
      meta.append(
        htmlElement(this.document, "span", "", `${entry.commentCount} 条评论`),
        htmlElement(this.document, "span", "", `${entry.translatedCount} 条译文`),
        htmlElement(this.document, "span", "", this.#formatBytes(entry.bytes)),
        htmlElement(this.document, "time", "", this.#summaryTime(entry.savedAt)),
      );
      const actions = htmlElement(this.document, "div", "hnr-download-history-actions");
      const download = htmlElement(this.document, "button", "hnr-download-history-action");
      download.type = "button";
      download.setAttribute("aria-label", `再次下载 ${entry.storyTitle} 的离线 HTML`);
      const downloadTooltip = tooltipElement(
        this.document,
        `再次下载 ${entry.filename}`,
        `hnr-tooltip-download-${index}`,
      );
      download.setAttribute("aria-describedby", downloadTooltip.id);
      download.append(
        iconElement(this.document, ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "m7 10 5 5 5-5", "M12 15V3"]),
        htmlElement(this.document, "span", "", "下载"),
        downloadTooltip,
      );
      download.addEventListener("click", () => this.#offlineOnDownload?.(entry));
      const remove = htmlElement(this.document, "button", "hnr-download-history-action hnr-download-history-delete");
      remove.type = "button";
      remove.setAttribute("aria-label", `删除 ${entry.storyTitle} 的下载历史`);
      const removeLabel = htmlElement(this.document, "span", "", "删除");
      const removeTooltip = tooltipElement(
        this.document,
        `删除 ${entry.filename}`,
        `hnr-tooltip-delete-download-${index}`,
      );
      remove.setAttribute("aria-describedby", removeTooltip.id);
      remove.append(
        iconElement(this.document, ["M3 6h18", "M8 6V4h8v2", "m19 6-1 14H6L5 6", "M10 11v5", "M14 11v5"]),
        removeLabel,
        removeTooltip,
      );
      let deleteArmed = false;
      const resetDelete = (): void => {
        deleteArmed = false;
        remove.dataset.confirm = "false";
        removeLabel.textContent = "删除";
        remove.setAttribute("aria-label", `删除 ${entry.storyTitle} 的下载历史`);
      };
      remove.addEventListener("click", () => {
        if (deleteArmed) {
          this.#offlineOnDelete?.(entry);
          return;
        }
        deleteArmed = true;
        remove.dataset.confirm = "true";
        removeLabel.textContent = "确认删除";
        remove.setAttribute("aria-label", `确认删除 ${entry.storyTitle} 的下载历史`);
      });
      remove.addEventListener("blur", resetDelete);
      actions.append(download, remove);
      item.append(detail, meta, actions);
      list.append(item);
    }
    container.append(list);
  }

  #formatBytes(bytes: number): string {
    if (bytes < 1_024) return `${bytes} B`;
    if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
    return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
  }

  #summaryScopeLabel(scope: DiscussionSummaryScope): string {
    return scope.kind === "all" ? "全帖" : `分支 #${scope.rootId}`;
  }

  #summaryLengthLabel(length: SummaryLength): string {
    if (length === "short") return "精简";
    if (length === "detailed") return "详细";
    return "标准";
  }

  #summaryTime(timestamp: number): string {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(timestamp);
  }

  #removeSummarySurface(restoreFocus = true): void {
    this.#detachSummaryEscapeListener();
    this.#summarySurface?.remove();
    this.#summarySurface = null;
    this.#summaryOnSelect = null;
    this.#offlineOnDownload = null;
    this.#offlineOnDelete = null;
    this.#summaryActiveId = null;
    const returnFocus = this.#summaryReturnFocus;
    this.#summaryReturnFocus = null;
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }

  #detachSummaryEscapeListener(): void {
    const listener = this.#summaryEscapeListener;
    if (!listener) return;
    this.#summaryEscapeListener = null;
    this.document.removeEventListener("keydown", listener, true);
  }

  openSettings(
    settings: ReaderSettings,
    callbacks: {
      readonly onSave: (settings: ReaderSettings) => void;
      readonly onLoadModels: (profile: AiProfile) => Promise<readonly string[]>;
      readonly onThemePreview?: (theme: ReaderTheme) => void;
      readonly onSettingsPreview?: (settings: ReaderSettings) => void;
      readonly onClearCache: () => Promise<void>;
      readonly onReset: () => void;
      readonly queryLocalFonts?: LocalFontQuery;
    },
  ): void {
    this.#detachSettingsEscapeListener();
    this.#discardSettingsPreview();
    this.#removeSettingsSurface();
    this.#removeSummarySurface(false);
    this.#shadow.querySelector(".hnr-settings-backdrop")?.remove();
    const backdrop = htmlElement(this.document, "div", "hnr-settings-backdrop");
    const form = htmlElement(this.document, "form", "hnr-settings hnr-settings-popover");
    form.setAttribute("role", "dialog");
    form.setAttribute("aria-modal", "true");
    const panelDefinitions = [
      {
        id: "reading",
        group: "阅读",
        title: "阅读与翻译",
        description: "设置自动翻译、翻译服务和正文显示方式。",
        icon: ["M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z", "M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"],
      },
      {
        id: "font",
        group: "阅读",
        title: "字体与排版",
        description: "分别调整 Reader 标题与评论正文的字体，并设置正文字重、字号和行高。",
        icon: ["M4 7V4h16v3", "M9 20h6", "M12 4v16"],
      },
      {
        id: "ai",
        group: "服务",
        title: "AI 服务",
        description: "配置 OpenAI-compatible 模型，仅在明确选择或触发时请求。",
        icon: ["m12 3-1.4 3.6L7 8l3.6 1.4L12 13l1.4-3.6L17 8l-3.6-1.4z", "m19 14-.8 2.2L16 17l2.2.8L19 20l.8-2.2L22 17l-2.2-.8z"],
      },
      {
        id: "storage",
        group: "数据",
        title: "本地数据",
        description: "清理缓存与本地历史，或把所有阅读设置恢复为默认值。",
        icon: ["M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z", "M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6", "M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"],
      },
    ] as const;
    type SettingsPanelId = typeof panelDefinitions[number]["id"];
    const field = (labelText: string, control: HTMLElement): HTMLLabelElement => {
      const label = htmlElement(this.document, "label", "hnr-field");
      label.append(htmlElement(this.document, "span", "", labelText), control);
      return label;
    };
    const select = <T extends string>(name: string, value: T, options: readonly (readonly [T, string])[]): HTMLSelectElement => {
      const control = htmlElement(this.document, "select");
      control.name = name;
      for (const [optionValue, label] of options) {
        const option = htmlElement(this.document, "option", "", label);
        option.value = optionValue;
        option.selected = optionValue === value;
        control.append(option);
      }
      return control;
    };
    const textInput = (name: string, value: string, type: "text" | "password" = "text"): HTMLInputElement => {
      const input = htmlElement(this.document, "input");
      input.name = name;
      input.type = type;
      input.value = value;
      input.autocomplete = type === "password" ? "new-password" : "off";
      return input;
    };
    const numberInput = (name: string, value: number, min: number, max: number, step: number): HTMLInputElement => {
      const input = textInput(name, String(value));
      input.type = "number";
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      return input;
    };
    const rangeInput = (name: string, value: number, min: number, max: number, step: number): HTMLInputElement => {
      const input = numberInput(name, value, min, max, step);
      input.type = "range";
      return input;
    };

    const tabs = new Map<SettingsPanelId, HTMLButtonElement>();
    const sections = new Map<SettingsPanelId, HTMLElement>();
    const panelHosts = new Map<SettingsPanelId, HTMLElement>();
    const groups = new Map<string, HTMLElement>();
    let activePanel: SettingsPanelId = "reading";

    const sidebar = htmlElement(this.document, "aside", "hnr-settings-tabs");
    const brand = htmlElement(this.document, "div", "hnr-settings-brand");
    const brandMark = htmlElement(this.document, "span", "hnr-settings-brand-mark", "Y");
    brandMark.setAttribute("aria-hidden", "true");
    const brandName = htmlElement(this.document, "span", "hnr-settings-brand-name");
    for (const line of ["HACKER", "NEWS", "READER"]) brandName.append(htmlElement(this.document, "span", "", line));
    brand.append(brandMark, brandName);
    const searchShell = htmlElement(this.document, "div", "hnr-settings-search-shell");
    const searchLabel = htmlElement(this.document, "label", "hnr-settings-search");
    searchLabel.append(iconElement(this.document, ["M21 21l-4.35-4.35", "M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0z"]));
    const search = textInput("", "");
    search.removeAttribute("name");
    search.type = "search";
    search.placeholder = "搜索设置…";
    search.setAttribute("aria-label", "搜索设置");
    const searchClear = htmlElement(this.document, "button", "hnr-settings-search-clear");
    searchClear.type = "button";
    searchClear.hidden = true;
    searchClear.setAttribute("aria-label", "清空设置搜索");
    searchClear.append(iconElement(this.document, ["M6 6l12 12", "M18 6 6 18"]));
    searchLabel.append(search, searchClear);
    const searchStatus = htmlElement(this.document, "span", "hnr-settings-search-status", "输入名称或功能即可筛选");
    searchStatus.setAttribute("role", "status");
    searchShell.append(searchLabel, searchStatus);
    brand.append(searchShell);

    const navShell = htmlElement(this.document, "div", "hnr-settings-nav-shell");
    const nav = htmlElement(this.document, "nav", "hnr-settings-nav");
    nav.setAttribute("role", "tablist");
    nav.setAttribute("aria-label", "设置分类");
    for (const groupName of ["阅读", "服务", "数据"]) {
      const group = htmlElement(this.document, "div", "hnr-settings-nav-group");
      group.dataset.settingsGroup = groupName;
      group.append(htmlElement(this.document, "span", "hnr-settings-nav-group-label", groupName));
      for (const definition of panelDefinitions.filter((panel) => panel.group === groupName)) {
        const tab = htmlElement(this.document, "button", "hnr-settings-tab");
        tab.type = "button";
        tab.id = `hnr-settings-tab-${definition.id}`;
        tab.dataset.settingsPanel = definition.id;
        tab.setAttribute("role", "tab");
        tab.setAttribute("aria-controls", `hnr-settings-panel-${definition.id}`);
        tab.append(iconElement(this.document, definition.icon), htmlElement(this.document, "span", "", definition.title));
        tabs.set(definition.id, tab);
        group.append(tab);
      }
      groups.set(groupName, group);
      nav.append(group);
    }
    navShell.append(nav);
    const sidebarFooter = htmlElement(this.document, "div", "hnr-settings-sidebar-footer");
    const theme = select("theme", settings.theme, [["auto", "跟随系统"], ["light", "浅色"], ["dark", "深色"]]);
    theme.setAttribute("aria-label", "阅读器主题");
    sidebarFooter.append(htmlElement(this.document, "span", "", "主题"), theme);
    sidebar.append(brand, navShell, sidebarFooter);

    const settingsPanel = htmlElement(this.document, "div", "hnr-settings-panel");
    const pages = htmlElement(this.document, "div", "hnr-settings-pages");
    const searchEmpty = htmlElement(this.document, "div", "hnr-settings-search-empty");
    searchEmpty.hidden = true;
    searchEmpty.append(
      iconElement(this.document, ["M21 21l-4.35-4.35", "M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0z"]),
      htmlElement(this.document, "strong", "", "没有找到匹配的设置"),
      htmlElement(this.document, "span", "", "试试“字体”“翻译”“AI”或“缓存”。"),
    );
    pages.append(searchEmpty);
    for (const definition of panelDefinitions) {
      const section = htmlElement(this.document, "section", "hnr-settings-section");
      section.id = `hnr-settings-panel-${definition.id}`;
      section.dataset.settingsPanel = definition.id;
      section.setAttribute("role", "tabpanel");
      section.setAttribute("aria-labelledby", `hnr-settings-tab-${definition.id}`);
      const intro = htmlElement(this.document, "div", "hnr-settings-intro");
      const title = htmlElement(this.document, "h2", "hnr-settings-title", definition.title);
      title.id = `hnr-settings-title-${definition.id}`;
      intro.append(title, htmlElement(this.document, "p", "hnr-settings-description", definition.description));
      const host = htmlElement(this.document, "div", "hnr-settings-content");
      host.dataset.settingsContent = definition.id;
      section.append(intro, host);
      sections.set(definition.id, section);
      panelHosts.set(definition.id, host);
      pages.append(section);
    }

    const translationThemeLabels: Readonly<Record<ReaderTranslationTheme, string>> = Object.freeze({
      quote: "淡灰引用",
      plain: "自然正文",
      weakening: "弱化译文",
      "dividing-line": "分隔线",
      underline: "下划线",
      highlight: "柔和高亮",
      paper: "纸张卡片",
    });
    const translationTheme = select(
      "translationTheme",
      settings.translationTheme,
      READER_TRANSLATION_THEMES.map((theme) => [theme, translationThemeLabels[theme]] as const),
    );
    translationTheme.setAttribute("aria-label", "译文呈现样式");
    const translationThemePreview = htmlElement(this.document, "span", "hnr-translation-theme-preview hnr-bilingual-text");
    translationThemePreview.setAttribute("aria-label", "译文样式效果预览");
    translationThemePreview.append(
      htmlElement(this.document, "span", "hnr-bilingual-original-section", "Knowledge grows when ideas are shared."),
      htmlElement(this.document, "span", "hnr-bilingual-translation-section", "知识会在分享中不断生长。"),
    );
    const translationThemeControl = htmlElement(this.document, "span", "hnr-translation-theme-control");
    translationThemeControl.append(translationTheme);
    const translationThemeField = field("译文样式", translationThemeControl);
    translationThemeField.classList.add("hnr-translation-theme-field");
    translationThemeField.append(translationThemePreview);
    const readingGroup = htmlElement(this.document, "fieldset", "hnr-settings-card hnr-reading-settings");
    readingGroup.append(
      htmlElement(this.document, "legend", "", "翻译阅读"),
      field("翻译服务", select("provider", settings.translationProvider, [["auto", "公共自动"], ["google", "Google"], ["microsoft", "Microsoft"], ["ai", "自定义 AI"]])),
      field("显示方式", select("mode", settings.translationMode, [["original", "仅原文"], ["bilingual", "双语"], ["translated", "仅译文"]])),
      field("滚动预翻译", select("translationEnabled", settings.translationEnabled ? "on" : "off", [["on", "开启（持久化）"], ["off", "关闭"]])),
      translationThemeField,
    );
    panelHosts.get("reading")?.append(readingGroup);

    const aiBaseUrl = textInput("aiBaseUrl", settings.ai.baseUrl);
    const aiApiKey = textInput("aiApiKey", settings.ai.apiKey, "password");
    const aiModel = textInput("aiModel", settings.ai.model);
    const modelSelect = htmlElement(this.document, "select", "hnr-model-select");
    modelSelect.disabled = true;
    modelSelect.setAttribute("aria-label", "选择已获取模型");
    const loadModels = htmlElement(this.document, "button", "hnr-load-models", "获取模型");
    loadModels.type = "button";
    const modelPicker = htmlElement(this.document, "div", "hnr-model-picker");
    modelPicker.append(aiModel, modelSelect, loadModels);
    const prompt = htmlElement(this.document, "textarea");
    prompt.name = "aiPrompt";
    prompt.rows = 3;
    prompt.value = settings.ai.prompt;
    const aiSection = htmlElement(this.document, "fieldset", "hnr-settings-card hnr-ai-settings");
    aiSection.append(
      htmlElement(this.document, "legend", "", "自定义 AI（OpenAI-compatible）"),
      field("Base URL", aiBaseUrl),
      field("API Key", aiApiKey),
      field("模型", modelPicker),
      field("附加提示词", prompt),
      field("RPM（0 为不限）", numberInput("aiRpm", settings.ai.requestsPerMinute, 0, 10_000, 1)),
      field("TPM（0 为不限）", numberInput("aiTpm", settings.ai.tokensPerMinute, 0, 10_000_000, 100)),
    );
    panelHosts.get("ai")?.append(aiSection);
    const localFontQuery = callbacks.queryLocalFonts ?? this.#queryLocalFonts;
    let resolvedLocalFonts: readonly string[] | null = null;
    let pendingLocalFonts: Promise<readonly string[]> | null = null;
    const sharedLocalFontQuery: LocalFontQuery | undefined = localFontQuery
      ? async () => {
        if (resolvedLocalFonts) return resolvedLocalFonts;
        pendingLocalFonts ??= localFontQuery().then((families) => {
          resolvedLocalFonts = families;
          return families;
        });
        try {
          return await pendingLocalFonts;
        } finally {
          pendingLocalFonts = null;
        }
      }
      : undefined;
    const titleFontPicker = new LocalFontPicker({
      document: this.document,
      fontFamily: settings.titleFontFamily,
      customFontFamily: settings.titleCustomFontFamily,
      fontFamilyName: "titleFontFamily",
      customFontFamilyName: "titleCustomFontFamily",
      queryLocalFonts: sharedLocalFontQuery,
    });
    const bodyFontPicker = new LocalFontPicker({
      document: this.document,
      fontFamily: settings.fontFamily,
      customFontFamily: settings.customFontFamily,
      queryLocalFonts: sharedLocalFontQuery,
    });
    const fontRendering = select(
      "fontRenderingEnabled",
      settings.fontRenderingEnabled ? "on" : "off",
      [["on", "开启"], ["off", "关闭"]],
    );
    const fontWeight = select(
      "fontWeight",
      String(settings.fontWeight),
      READER_FONT_WEIGHTS.map((weight) => [String(weight), `${weight === 300 ? "细" : weight === 400 ? "常规" : weight === 500 ? "中等" : "半粗"} ${weight}`] as const),
    );
    const fontScale = rangeInput("fontScale", settings.fontScale, .85, 1.35, .01);
    const lineHeight = rangeInput("lineHeight", settings.lineHeight, 1.35, 2, .01);
    fontRendering.setAttribute("aria-label", "字体显示优化");
    fontWeight.setAttribute("aria-label", "评论正文字重");
    fontScale.setAttribute("aria-label", "评论正文字号");
    lineHeight.setAttribute("aria-label", "评论正文行高");
    const fontScaleValue = htmlElement(this.document, "output", "hnr-font-range-value");
    const lineHeightValue = htmlElement(this.document, "output", "hnr-font-range-value");
    const fontRow = (titleText: string, description: string, control: HTMLElement): HTMLElement => {
      const row = htmlElement(this.document, "div", "hnr-font-setting-row");
      const copy = htmlElement(this.document, "span", "hnr-font-setting-copy");
      copy.append(
        htmlElement(this.document, "strong", "", titleText),
        htmlElement(this.document, "small", "", description),
      );
      row.append(copy, control);
      return row;
    };
    const weightControl = htmlElement(this.document, "span", "hnr-font-option-control");
    weightControl.append(fontWeight);
    const renderingControl = htmlElement(this.document, "span", "hnr-font-option-control");
    renderingControl.append(fontRendering);
    const scaleControl = htmlElement(this.document, "span", "hnr-font-range-control");
    scaleControl.append(fontScale, fontScaleValue);
    const lineHeightControl = htmlElement(this.document, "span", "hnr-font-range-control");
    lineHeightControl.append(lineHeight, lineHeightValue);
    const fontPreview = htmlElement(this.document, "div", "hnr-font-preview");
    fontPreview.append(
      htmlElement(this.document, "strong", "hnr-font-title-preview", "Hacker News 标题字体预览"),
      htmlElement(this.document, "span", "hnr-font-body-preview", "评论正文预览：春江潮水连海平。The quick brown fox jumps over 0123456789."),
    );
    const fontSettings = htmlElement(this.document, "fieldset", "hnr-settings-card hnr-font-settings");
    fontSettings.append(
      htmlElement(this.document, "legend", "", "阅读排版"),
      fontRow("字体显示优化", "在 Reader 中启用内置字体平滑、描边和阴影优化。", renderingControl),
      fontRow("标题字体", "用于 Reader 顶部故事标题与中文译题。", titleFontPicker.element),
      fontRow("正文字体", "自动读取浏览器可用字体；支持搜索、选择和即时预览。", bodyFontPicker.element),
      fontRow("字重", "仅影响评论正文。", weightControl),
      fontRow("字号", "85% – 135%", scaleControl),
      fontRow("行高", "1.35 – 2.00", lineHeightControl),
      fontPreview,
    );
    panelHosts.get("font")?.append(fontSettings);

    const storageCard = htmlElement(this.document, "section", "hnr-settings-card hnr-storage-settings");
    const storageCopy = htmlElement(this.document, "div", "hnr-storage-copy");
    storageCopy.append(
      htmlElement(this.document, "strong", "", "缓存与设置"),
      htmlElement(this.document, "span", "", "清理会删除总结与下载历史，但不会删除 API Key；恢复默认会重置完整设置。"),
    );
    const storageActions = htmlElement(this.document, "div", "hnr-storage-actions");
    const clear = htmlElement(this.document, "button", "", "清理缓存与历史");
    clear.type = "button";
    const reset = htmlElement(this.document, "button", "hnr-danger", "恢复默认");
    reset.type = "button";
    storageActions.append(clear, reset);
    storageCard.append(storageCopy, storageActions);
    panelHosts.get("storage")?.append(storageCard);

    const status = htmlElement(this.document, "div", "hnr-settings-status", "更改将在保存后生效；字体排版可实时预览。");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    const draftBar = htmlElement(this.document, "div", "hnr-settings-draft-bar");
    const actions = htmlElement(this.document, "div", "hnr-settings-actions");
    const cancel = htmlElement(this.document, "button", "hnr-settings-cancel", "取消");
    cancel.type = "button";
    const save = htmlElement(this.document, "button", "hnr-primary", "保存全部更改");
    save.type = "submit";
    actions.append(cancel, save);
    draftBar.append(status, actions);
    settingsPanel.append(pages, draftBar);
    const close = htmlElement(this.document, "button", "hnr-settings-close");
    close.type = "button";
    close.setAttribute("aria-label", "关闭设置");
    close.append(iconElement(this.document, ["M6 6l12 12", "M18 6 6 18"]));
    form.append(sidebar, settingsPanel, close);
    backdrop.append(form);
    this.#shell.append(backdrop);
    this.#settingsSurfaceCleanup = () => {
      titleFontPicker.destroy();
      bodyFontPicker.destroy();
      backdrop.remove();
    };

    const setStatus = (message: string, tone: "neutral" | "success" | "error" = "neutral"): void => {
      status.textContent = message;
      status.dataset.tone = tone;
      status.setAttribute("role", tone === "error" ? "alert" : "status");
    };
    const activatePanel = (panelId: SettingsPanelId): void => {
      activePanel = panelId;
      if (panelId === "font") {
        titleFontPicker.activate();
        bodyFontPicker.activate();
      }
      for (const definition of panelDefinitions) {
        const active = definition.id === panelId;
        const tab = tabs.get(definition.id);
        const section = sections.get(definition.id);
        if (tab) {
          tab.classList.toggle("active", active);
          tab.setAttribute("aria-selected", String(active));
          tab.tabIndex = active ? 0 : -1;
        }
        if (section) section.hidden = !active;
      }
      form.setAttribute("aria-labelledby", `hnr-settings-title-${panelId}`);
      pages.scrollTop = 0;
    };
    for (const [panelId, tab] of tabs) tab.addEventListener("click", () => activatePanel(panelId));
    nav.addEventListener("keydown", (event) => {
      if (!(event instanceof KeyboardEvent) || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
      const visibleTabs = [...tabs.values()].filter((tab) => !tab.hidden);
      const current = visibleTabs.indexOf(this.#shadow.activeElement as HTMLButtonElement);
      const offset = event.key === "ArrowDown" ? 1 : -1;
      const next = visibleTabs[(current + offset + visibleTabs.length) % visibleTabs.length];
      next?.focus();
      if (next?.dataset.settingsPanel) activatePanel(next.dataset.settingsPanel as SettingsPanelId);
      event.preventDefault();
    });
    const syncSearch = (): void => {
      const query = search.value.trim().toLocaleLowerCase();
      let visibleCount = 0;
      for (const definition of panelDefinitions) {
        const section = sections.get(definition.id);
        const haystack = `${definition.title} ${definition.description} ${section?.textContent ?? ""}`.toLocaleLowerCase();
        const visible = !query || haystack.includes(query);
        const tab = tabs.get(definition.id);
        if (tab) tab.hidden = !visible;
        if (visible) visibleCount += 1;
      }
      for (const [groupName, group] of groups) {
        group.hidden = !panelDefinitions.some((definition) => definition.group === groupName && !tabs.get(definition.id)?.hidden);
      }
      searchClear.hidden = query.length === 0;
      searchEmpty.hidden = visibleCount > 0;
      searchStatus.textContent = query
        ? visibleCount > 0 ? `找到 ${visibleCount} 个设置分区` : "没有匹配结果"
        : "输入名称或功能即可筛选";
      if (tabs.get(activePanel)?.hidden) {
        const firstVisible = panelDefinitions.find((definition) => !tabs.get(definition.id)?.hidden);
        if (firstVisible) activatePanel(firstVisible.id);
      }
    };
    search.addEventListener("input", syncSearch);
    searchClear.addEventListener("click", () => {
      search.value = "";
      syncSearch();
      search.focus();
    });
    activatePanel(activePanel);
    loadModels.addEventListener("click", () => {
      loadModels.disabled = true;
      setStatus("正在读取 /models…");
      const profile: AiProfile = {
        ...settings.ai,
        baseUrl: aiBaseUrl.value,
        apiKey: aiApiKey.value,
        model: aiModel.value,
      };
      void callbacks.onLoadModels(profile).then((models) => {
        modelSelect.replaceChildren(...models.map((model) => {
          const option = htmlElement(this.document, "option");
          option.value = model;
          option.textContent = model;
          option.selected = model === aiModel.value;
          return option;
        }));
        if (!aiModel.value.trim() && models[0]) aiModel.value = models[0];
        modelSelect.disabled = models.length === 0;
        if (models.includes(aiModel.value)) modelSelect.value = aiModel.value;
        else modelSelect.selectedIndex = -1;
        setStatus(`已获取 ${models.length} 个模型。`, "success");
      }).catch((reason: unknown) => {
        setStatus(reason instanceof Error ? reason.message : "模型列表获取失败", "error");
      }).finally(() => { loadModels.disabled = false; });
    });
    modelSelect.addEventListener("change", () => {
      if (modelSelect.value) aiModel.value = modelSelect.value;
    });
    aiModel.addEventListener("input", () => {
      if ([...modelSelect.options].some((option) => option.value === aiModel.value)) modelSelect.value = aiModel.value;
      else modelSelect.selectedIndex = -1;
    });
    const previewAppearance = (): void => {
      const preview = normalizeSettings({
        ...settings,
        theme: theme.value,
        titleFontFamily: titleFontPicker.fontFamilyInput.value,
        titleCustomFontFamily: titleFontPicker.customFontFamilyInput.value,
        fontFamily: bodyFontPicker.fontFamilyInput.value,
        customFontFamily: bodyFontPicker.customFontFamilyInput.value,
        fontRenderingEnabled: fontRendering.value === "on",
        fontWeight: fontWeight.value,
        fontScale: fontScale.value,
        lineHeight: lineHeight.value,
        translationTheme: translationTheme.value,
      });
      fontScaleValue.value = `${Math.round(preview.fontScale * 100)}%`;
      lineHeightValue.value = preview.lineHeight.toFixed(2);
      this.applySettings(preview);
      callbacks.onThemePreview?.(preview.theme);
      callbacks.onSettingsPreview?.(preview);
    };
    this.#settingsPreviewRestore = () => {
      this.applySettings(settings);
      callbacks.onThemePreview?.(settings.theme);
      callbacks.onSettingsPreview?.(settings);
    };
    for (const control of [fontRendering, fontWeight, fontScale, lineHeight, translationTheme]) {
      control.addEventListener(control.tagName === "SELECT" ? "change" : "input", previewAppearance);
    }
    titleFontPicker.fontFamilyInput.addEventListener("change", previewAppearance);
    bodyFontPicker.fontFamilyInput.addEventListener("change", previewAppearance);
    theme.addEventListener("change", previewAppearance);
    previewAppearance();
    const cancelSettings = (): void => {
      this.#detachSettingsEscapeListener();
      this.#discardSettingsPreview();
      this.#removeSettingsSurface();
    };
    const escapeListener: EventListener = (event) => {
      const keyboardEvent = event as KeyboardEvent;
      if (keyboardEvent.key !== "Escape" || !backdrop.isConnected) return;
      if (titleFontPicker.handleEscape() || bodyFontPicker.handleEscape()) {
        keyboardEvent.preventDefault();
        keyboardEvent.stopPropagation();
        return;
      }
      cancelSettings();
      keyboardEvent.preventDefault();
      keyboardEvent.stopPropagation();
    };
    this.#settingsEscapeListener = escapeListener;
    this.document.addEventListener("keydown", escapeListener, true);
    cancel.addEventListener("click", cancelSettings);
    close.addEventListener("click", cancelSettings);
    form.addEventListener("pointerdown", (event) => {
      if (titleFontPicker.expanded && !titleFontPicker.containsEvent(event)) titleFontPicker.close();
      if (bodyFontPicker.expanded && !bodyFontPicker.containsEvent(event)) bodyFontPicker.close();
    });
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) cancelSettings();
    });
    clear.addEventListener("click", () => {
      clear.disabled = true;
      void callbacks.onClearCache().then(() => {
        setStatus("缓存与本地历史已清理。", "success");
      }).catch((reason: unknown) => {
        setStatus(reason instanceof Error ? reason.message : "缓存清理失败", "error");
      }).finally(() => { clear.disabled = false; });
    });
    reset.addEventListener("click", () => {
      this.#detachSettingsEscapeListener();
      this.#settingsPreviewRestore = null;
      callbacks.onReset();
      this.#removeSettingsSurface();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const data = new FormData(form);
      try {
        const next = normalizeSettings({
          ...settings,
          translationProvider: data.get("provider"),
          translationMode: data.get("mode"),
          translationTheme: data.get("translationTheme"),
          translationEnabled: data.get("translationEnabled") === "on",
          theme: data.get("theme"),
          titleFontFamily: data.get("titleFontFamily"),
          titleCustomFontFamily: data.get("titleCustomFontFamily"),
          fontFamily: data.get("fontFamily"),
          customFontFamily: data.get("customFontFamily"),
          fontRenderingEnabled: data.get("fontRenderingEnabled") === "on",
          fontWeight: data.get("fontWeight"),
          fontScale: data.get("fontScale"),
          lineHeight: data.get("lineHeight"),
          ai: {
            baseUrl: data.get("aiBaseUrl"),
            apiKey: data.get("aiApiKey"),
            model: data.get("aiModel"),
            prompt: data.get("aiPrompt"),
            requestsPerMinute: data.get("aiRpm"),
            tokensPerMinute: data.get("aiTpm"),
          },
        });
        callbacks.onSave(next);
        this.#detachSettingsEscapeListener();
        this.#settingsPreviewRestore = null;
        this.#removeSettingsSurface();
      } catch (reason) {
        activatePanel("ai");
        setStatus(reason instanceof Error ? reason.message : "设置无效", "error");
      }
    });
    for (const eventName of ["input", "change"]) {
      form.addEventListener(eventName, (event) => {
        if (event.target === search) return;
        setStatus("有未保存的更改。");
      });
    }
    queueMicrotask(() => tabs.get(activePanel)?.focus());
  }

  destroy(): void {
    this.#detachSettingsEscapeListener();
    this.#removeSettingsSurface();
    this.#scope.destroy();
  }

  #detachSettingsEscapeListener(): void {
    const listener = this.#settingsEscapeListener;
    if (!listener) return;
    this.#settingsEscapeListener = null;
    this.document.removeEventListener("keydown", listener, true);
  }

  #discardSettingsPreview(): void {
    const restore = this.#settingsPreviewRestore;
    this.#settingsPreviewRestore = null;
    restore?.();
  }

  #removeSettingsSurface(): void {
    const cleanup = this.#settingsSurfaceCleanup;
    if (!cleanup) return;
    this.#settingsSurfaceCleanup = null;
    cleanup();
  }

  #ancestorsFor(entry: VisibleEntry): readonly CommentId[] {
    if (entry.kind === "comment") return this.#tree.ancestors(entry.id);
    if (entry.parentId === this.#tree.story.id) return [];
    return Object.freeze([...this.#tree.ancestors(entry.parentId as CommentId), entry.parentId as CommentId]);
  }

  #renderEntry(entry: VisibleEntry, index: number): HTMLElement {
    if (entry.kind === "missing") {
      const missing = htmlElement(this.document, "div", "hnr-missing");
      missing.setAttribute("role", "treeitem");
      missing.setAttribute("aria-level", String(entry.depth + 1));
      missing.style.setProperty("--hnr-depth", String(Math.min(entry.depth, 12)));
      const button = htmlElement(this.document, "button", "hnr-missing-button", `加载缺失回复 #${entry.id}`);
      button.type = "button";
      button.dataset.action = "load-missing";
      button.dataset.commentId = String(entry.id);
      missing.append(button);
      return missing;
    }
    const comment = this.#tree.get(entry.id);
    const row = htmlElement(this.document, "article", "hnr-comment");
    row.dataset.commentId = String(entry.id);
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-level", String(entry.depth + 1));
    row.setAttribute("aria-expanded", entry.hasChildren ? String(!entry.collapsed) : "false");
    row.tabIndex = -1;
    row.style.setProperty("--hnr-depth", String(Math.min(entry.depth, 12)));
    row.dataset.depth = String(entry.depth);
    row.dataset.hasChildren = String(entry.hasChildren);
    row.dataset.collapsed = String(entry.collapsed);
    if (this.#newCommentHighlightIds.has(entry.id)) row.dataset.newComment = "true";
    if (!comment) return row;

    const rails = htmlElement(this.document, "span", "hnr-tree-rails");
    rails.setAttribute("aria-hidden", "true");
    const nextEntry = this.#visibleEntries[index + 1];
    const ancestors = this.#ancestorsFor(entry);
    const nextAncestors = nextEntry ? this.#ancestorsFor(nextEntry) : [];
    const branchPath = [...ancestors, entry.id];
    const makeCollapsibleLine = (className: string, branchId: CommentId): HTMLSpanElement => {
      const line = htmlElement(this.document, "span", `${className} hnr-tree-collapse-hit`);
      line.dataset.action = "toggle-comment";
      line.dataset.commentId = String(branchId);
      return line;
    };
    for (let level = 0; level < Math.min(entry.depth, 12); level += 1) {
      const parent = this.#tree.get(branchPath[level] as CommentId);
      const childId = branchPath[level + 1];
      const childIndex = childId === undefined ? -1 : parent?.childIds.indexOf(childId) ?? -1;
      const rail = parent
        ? makeCollapsibleLine("hnr-tree-rail", parent.id)
        : htmlElement(this.document, "span", "hnr-tree-rail");
      rail.style.setProperty("--hnr-rail-level", String(level));
      rail.dataset.continues = String(Boolean(parent && childIndex >= 0 && childIndex < parent.childIds.length - 1));
      rail.dataset.currentParent = String(level === entry.depth - 1);
      rails.append(rail);
    }
    if (entry.depth > 0) rails.append(htmlElement(this.document, "span", "hnr-tree-elbow"));
    if (!entry.collapsed && nextAncestors[entry.depth] === entry.id) {
      rails.append(makeCollapsibleLine("hnr-tree-stem", entry.id));
    }

    const head = htmlElement(this.document, "div", "hnr-comment-head");
    let branchToggle: HTMLButtonElement | null = null;
    const authorMarker = htmlElement(
      this.document,
      "span",
      "hnr-author-marker",
      (comment.author ?? "?").slice(0, 1).toLocaleUpperCase(),
    );
    authorMarker.setAttribute("aria-hidden", "true");
    const authorAvatar = createAuthorAvatarElement(this.document, comment.author);
    if (authorAvatar) authorMarker.append(authorAvatar);
    const author = htmlElement(this.document, "strong", "hnr-author", comment.author ?? (comment.deleted ? "[deleted]" : "unknown"));
    const idLink = htmlElement(this.document, "a", "hnr-permalink", `#${comment.id}`);
    idLink.href = `https://news.ycombinator.com/item?id=${comment.id}`;
    idLink.target = "_blank";
    idLink.rel = "noopener noreferrer";
    head.append(authorMarker, author, idLink);
    if (entry.hasChildren) {
      const label = entry.collapsed ? "展开分支" : "收起分支";
      branchToggle = htmlElement(this.document, "button", "hnr-branch-toggle");
      branchToggle.type = "button";
      branchToggle.dataset.action = "toggle-comment";
      branchToggle.dataset.commentId = String(comment.id);
      branchToggle.dataset.toggleSymbol = entry.collapsed ? "+" : "−";
      branchToggle.setAttribute("aria-label", label);
      const branchTooltip = tooltipElement(this.document, label, `hnr-tooltip-branch-${comment.id}`);
      branchToggle.setAttribute("aria-describedby", branchTooltip.id);
      branchToggle.append(branchTooltip);
      branchToggle.addEventListener("click", (event) => {
        event.stopPropagation();
        this.#focusedCommentId = comment.id;
        this.#toggleCommentStable(comment.id);
      });
    }
    const body = htmlElement(this.document, "div", "hnr-comment-body");
    const original = htmlElement(this.document, "div", "hnr-original-text");
    const safeHtml = this.#preheated.get(comment.id)?.sanitizedHtml
      ?? sanitizeHtml(comment.html, this.document, this.document.baseURI);
    original.innerHTML = safeHtml || (comment.deleted ? "[deleted]" : "");
    const translated = htmlElement(this.document, "div", "hnr-translated-text");
    const bilingual = htmlElement(this.document, "div", "hnr-bilingual-text");
    const translation = this.#translations.get(comment.id);
    if (translation?.html) translated.innerHTML = translation.html;
    else translated.textContent = translation?.text ?? "";
    if (translation?.bilingualHtml) bilingual.innerHTML = translation.bilingualHtml;
    translated.hidden = !translation || this.#translationMode !== "translated";
    bilingual.hidden = !translation || this.#translationMode !== "bilingual";
    original.hidden = Boolean(translation) && this.#translationMode !== "original";
    body.append(original, translated, bilingual);
    body.hidden = entry.collapsed;
    const commentActions = htmlElement(this.document, "div", "hnr-comment-actions");
    commentActions.setAttribute("aria-label", `评论 #${comment.id} 操作`);
    if (entry.hasChildren) {
      const label = entry.collapsed ? "展开此分支" : "收起此分支";
      const toggleAction = htmlElement(this.document, "button", "hnr-comment-action");
      toggleAction.type = "button";
      toggleAction.dataset.action = "toggle-comment";
      toggleAction.dataset.commentId = String(comment.id);
      toggleAction.setAttribute("aria-label", label);
      const tooltip = tooltipElement(this.document, label, `hnr-tooltip-toggle-${comment.id}`);
      toggleAction.setAttribute("aria-describedby", tooltip.id);
      toggleAction.append(
        iconElement(this.document, entry.collapsed ? EXPAND_ICON_PATHS : COLLAPSE_ICON_PATHS),
        tooltip,
      );
      toggleAction.addEventListener("click", (event) => {
        event.stopPropagation();
        this.#focusedCommentId = comment.id;
        this.#toggleCommentStable(comment.id);
      });
      commentActions.append(toggleAction);
    }
    for (const [action, label, paths] of COMMENT_ACTION_DEFINITIONS) {
      const actionLabel = commentActionLabel(action, label, this.#translations.get(comment.id)?.complete === true);
      const button = htmlElement(this.document, "button", "hnr-comment-action");
      button.type = "button";
      button.dataset.commentAction = action;
      button.dataset.commentId = String(comment.id);
      button.setAttribute("aria-label", actionLabel);
      const tooltip = tooltipElement(this.document, actionLabel, `hnr-tooltip-${action}-${comment.id}`);
      button.setAttribute("aria-describedby", tooltip.id);
      button.append(iconElement(this.document, paths), tooltip);
      commentActions.append(button);
    }
    commentActions.hidden = entry.collapsed;
    row.append(rails, head, body, commentActions);
    if (branchToggle) row.append(branchToggle);
    if (comment.dead) row.dataset.dead = "true";
    return row;
  }

  #handleClick(event: Event): void {
    const path = event.composedPath();
    const row = path.find((node): node is HTMLElement => node instanceof HTMLElement && node.classList.contains("hnr-comment"));
    const actionTarget = path.find((node): node is HTMLElement => node instanceof HTMLElement && node.dataset.action !== undefined);
    if (actionTarget?.dataset.action === "toggle-comment" && actionTarget.dataset.commentId) {
      this.#focusedCommentId = Number.parseInt(actionTarget.dataset.commentId, 10) as CommentId;
    } else if (row?.dataset.commentId) {
      this.#focusedCommentId = Number.parseInt(row.dataset.commentId, 10) as CommentId;
    }
    if (actionTarget?.dataset.action === "scroll-top") {
      if (
        event instanceof MouseEvent
        && event.button === 0
        && (event.ctrlKey || event.metaKey)
        && this.#titleJump.dataset.hnrExternal === "true"
      ) return;
      event.preventDefault();
      this.#commentViewport.scrollTop = 0;
      return;
    }
    const target = path.find((node): node is HTMLElement => node instanceof HTMLElement);
    if (!target) return;
    const command = target.dataset.command as ReaderCommand | undefined;
    if (command) {
      this.actions.onCommand(command);
      return;
    }
    const commentAction = target.dataset.commentAction as ReaderCommentAction | undefined;
    if (commentAction && target.dataset.commentId) {
      this.actions.onCommentAction(commentAction, Number.parseInt(target.dataset.commentId, 10) as CommentId);
      return;
    }
    const action = actionTarget?.dataset.action ?? target.dataset.action;
    const actionElement = actionTarget ?? target;
    if (action === "close") this.actions.onClose();
    if (action === "dismiss-new-comments") this.#dismissNewComments();
    if (action === "previous-new-comment") this.#selectNewComment(-1, false);
    if (action === "next-new-comment") this.#selectNewComment(1, false);
    if (action === "locate-new-comment" && actionElement.dataset.commentId) {
      const id = Number.parseInt(actionElement.dataset.commentId, 10) as CommentId;
      this.#focusComment(id);
      this.#startNewCommentHighlightTimers([id]);
    }
    if (action === "close-summary") this.#removeSummarySurface();
    if (action === "locate-summary-comment" && actionElement.dataset.commentId) {
      const id = Number.parseInt(actionElement.dataset.commentId, 10) as CommentId;
      this.#removeSummarySurface(false);
      this.#focusComment(id, true);
    }
    if (action === "toggle-comment" && actionElement.dataset.commentId) {
      this.#toggleCommentStable(Number.parseInt(actionElement.dataset.commentId, 10) as CommentId);
    }
    if (action === "load-missing" && actionElement.dataset.commentId) {
      this.actions.onLoadMissing(Number.parseInt(actionElement.dataset.commentId, 10) as CommentId);
    }
  }

  #syncTitleJump(tree: CommentTree): void {
    let externalUrl: string | null = null;
    if (tree.story.url) {
      try {
        externalUrl = assertSafeExternalUrl(tree.story.url).href;
      } catch {
        externalUrl = null;
      }
    }
    if (externalUrl) {
      this.#titleJump.href = externalUrl;
      this.#titleJump.target = "_blank";
      this.#titleJump.rel = "noopener noreferrer";
      this.#titleJump.dataset.hnrExternal = "true";
      this.#titleJump.setAttribute("aria-label", "单击回到评论顶部；Ctrl 或 Command 加鼠标左键打开外链");
      this.#titleJumpTooltip.textContent = "单击回顶 · Ctrl + 🖱️左键打开外链";
      return;
    }
    this.#titleJump.href = "#hnr-reader-comments";
    this.#titleJump.removeAttribute("target");
    this.#titleJump.removeAttribute("rel");
    this.#titleJump.removeAttribute("data-hnr-external");
    this.#titleJump.setAttribute("aria-label", "回到评论顶部");
    this.#titleJumpTooltip.textContent = "回到评论顶部";
  }

  #renderNewCommentsNotice(): void {
    const count = this.#newCommentNoticeIds.length;
    if (count === 0) {
      this.#newCommentsNotice.hidden = true;
      return;
    }
    this.#newCommentNoticeIndex = Math.min(this.#newCommentNoticeIndex, count - 1);
    const id = this.#newCommentNoticeIds[this.#newCommentNoticeIndex];
    const comment = id === undefined ? undefined : this.#tree.get(id);
    if (!comment || id === undefined) {
      this.#newCommentsNotice.hidden = true;
      return;
    }
    const excerpt = comment.text.replace(/\s+/g, " ").trim();
    const shortenedExcerpt = excerpt.length > 52 ? `${excerpt.slice(0, 52)}…` : excerpt;
    const author = comment.author ?? "unknown";
    this.#newCommentsLabel.textContent = `新评论 ${this.#newCommentNoticeIndex + 1}/${count} · ${author}${shortenedExcerpt ? ` · ${shortenedExcerpt}` : ""}`;
    this.#newCommentsCurrent.dataset.commentId = String(id);
    this.#newCommentsCurrent.setAttribute("aria-label", `定位新评论 ${this.#newCommentNoticeIndex + 1}/${count}，${author}`);
    this.#newCommentsNotice.hidden = false;
  }

  #selectNewComment(direction: -1 | 1, locate: boolean): void {
    const count = this.#newCommentNoticeIds.length;
    if (count === 0) return;
    this.#newCommentNoticeIndex = (this.#newCommentNoticeIndex + direction + count) % count;
    this.#renderNewCommentsNotice();
    if (!locate) return;
    const id = this.#newCommentNoticeIds[this.#newCommentNoticeIndex];
    if (id === undefined) return;
    this.#focusComment(id);
    this.#startNewCommentHighlightTimers([id]);
  }

  #dismissNewComments(): void {
    this.#newCommentNoticeIds.length = 0;
    this.#newCommentNoticeIndex = 0;
    this.#newCommentsNotice.hidden = true;
  }

  #startNewCommentHighlightTimers(ids: readonly CommentId[]): void {
    const view = this.document.defaultView;
    if (!view) return;
    for (const id of ids) {
      if (!this.#newCommentHighlightIds.has(id) || this.#newCommentHighlightTimers.has(id)) continue;
      const timer = view.setTimeout(() => {
        this.#newCommentHighlightTimers.delete(id);
        this.#newCommentHighlightIds.delete(id);
        this.#shadow.querySelector<HTMLElement>(`.hnr-comment[data-comment-id="${id}"]`)?.removeAttribute("data-new-comment");
      }, NEW_COMMENT_HIGHLIGHT_MS);
      this.#newCommentHighlightTimers.set(id, timer);
    }
  }

  #handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      const overlay = this.#shadow.querySelector<HTMLElement>(".hnr-settings-backdrop");
      if (overlay) {
        this.#detachSettingsEscapeListener();
        this.#discardSettingsPreview();
        overlay.remove();
      }
      else if (this.#summarySurface) this.#removeSummarySurface();
      else this.actions.onClose();
      event.preventDefault();
      return;
    }
    if (
      !this.#newCommentsNotice.hidden
      && (event.key === "ArrowLeft" || event.key === "ArrowRight")
      && !(event.target instanceof HTMLInputElement)
      && !(event.target instanceof HTMLTextAreaElement)
      && !(event.target instanceof HTMLSelectElement)
    ) {
      this.#selectNewComment(event.key === "ArrowLeft" ? -1 : 1, true);
      event.preventDefault();
      return;
    }
    if (event.key === "Tab") {
      const container = this.#shadow.querySelector<HTMLElement>(".hnr-settings-backdrop");
      if (!container) return;
      const focusable = [...container.querySelectorAll<HTMLElement>("button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])")]
        .filter((element) => !element.closest("[hidden]"));
      const first = focusable[0];
      const last = focusable.at(-1);
      if (first && last && event.shiftKey && this.#shadow.activeElement === first) {
        last.focus();
        event.preventDefault();
      } else if (first && last && !event.shiftKey && this.#shadow.activeElement === last) {
        first.focus();
        event.preventDefault();
      }
      return;
    }
    const rows = [...this.#shadow.querySelectorAll<HTMLElement>(".hnr-comment")];
    const active = this.#shadow.activeElement?.closest<HTMLElement>(".hnr-comment");
    if (!active) {
      if (this.#shadow.activeElement === this.#commentViewport && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        (event.key === "ArrowDown" ? rows[0] : rows.at(-1))?.focus();
        event.preventDefault();
      }
      return;
    }
    if (active.dataset.commentId) this.#focusedCommentId = Number.parseInt(active.dataset.commentId, 10) as CommentId;
    const index = rows.indexOf(active);
    if (event.key === "ArrowDown") rows[index + 1]?.focus();
    else if (event.key === "ArrowUp") rows[index - 1]?.focus();
    else if (event.key === "ArrowLeft" && active.dataset.commentId) {
      const id = Number.parseInt(active.dataset.commentId, 10) as CommentId;
      if (!this.#projection.isCollapsed(id)) this.#toggleCommentStable(id);
      else {
        const parent = this.#tree.ancestors(id).at(-1);
        if (parent) this.#focusComment(parent);
      }
    } else if (event.key === "ArrowRight" && active.dataset.commentId) {
      const id = Number.parseInt(active.dataset.commentId, 10) as CommentId;
      if (this.#projection.isCollapsed(id)) this.#toggleCommentStable(id);
    } else return;
    event.preventDefault();
  }

  #toggleCommentStable(id: CommentId): void {
    this.#commentAnchorGeneration += 1;
    const generation = this.#commentAnchorGeneration;
    if (this.#commentAnchorFrame !== null) this.document.defaultView?.cancelAnimationFrame(this.#commentAnchorFrame);
    this.#commentAnchorFrame = null;
    const selector = `.hnr-comment[data-comment-id="${id}"]`;
    const before = this.#shadow.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
    const viewport = this.#commentViewport.getBoundingClientRect();
    const visibleHead = Math.min(44, Math.max(1, before?.height ?? 1));
    const latestVisibleTop = Math.max(viewport.top, viewport.bottom - visibleHead);
    const wasCollapsed = this.#projection.isCollapsed(id);
    const collapsedAnchorTop = Math.min(viewport.top + COLLAPSED_COMMENT_VIEWPORT_INSET_PX, latestVisibleTop);
    const anchorTop = wasCollapsed
      ? before?.top
      : before && before.top >= viewport.top && before.top <= latestVisibleTop
        ? before.top
        : collapsedAnchorTop;
    this.actions.onToggleComment(id);
    if (anchorTop === undefined) return;
    this.#pinLocatedComment(id, anchorTop - viewport.top);
    this.#alignCommentAnchor(selector, id, anchorTop);
    const view = this.document.defaultView;
    if (!view) return;
    this.#commentAnchorFrame = view.requestAnimationFrame(() => {
      this.#commentAnchorFrame = null;
      if (this.#scope.destroyed || generation !== this.#commentAnchorGeneration) return;
      this.#alignCommentAnchor(selector, id, anchorTop);
      this.#commentAnchorFrame = view.requestAnimationFrame(() => {
        this.#commentAnchorFrame = null;
        if (this.#scope.destroyed || generation !== this.#commentAnchorGeneration) return;
        this.#alignCommentAnchor(selector, id, anchorTop);
      });
    });
  }

  #alignCommentAnchor(selector: string, id: CommentId, anchorTop: number): void {
    let target = this.#shadow.querySelector<HTMLElement>(selector);
    if (!target) {
      const index = this.#visibleEntries.findIndex((entry) => entry.id === id);
      if (index < 0) return;
      this.#virtualList.scrollToIndex(index);
      target = this.#shadow.querySelector<HTMLElement>(selector);
    }
    if (!target) return;
    const delta = target.getBoundingClientRect().top - anchorTop;
    if (Math.abs(delta) > 0.5) this.#commentViewport.scrollTop += delta;
  }

  #focusComment(id: CommentId, flash = false): boolean {
    if (!this.#tree.has(id)) return false;
    this.#projection.reveal(id);
    const entries = this.#projection.entries();
    const index = entries.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    this.#visibleEntries = entries;
    this.#virtualList.setEntries(
      entries,
      this.#preheated.size > 0 ? entries.map((entry) => this.#preheated.get(entry.id)?.estimatedHeight ?? 112) : undefined,
    );
    this.#virtualList.scrollToIndex(index);
    this.#focusedCommentId = id;
    this.#pinLocatedComment(id);
    this.#locateFocusGeneration += 1;
    const generation = this.#locateFocusGeneration;
    if (this.#locateFocusFrame !== null) this.document.defaultView?.cancelAnimationFrame(this.#locateFocusFrame);
    this.#locateFocusFrame = null;
    const focusMountedTarget = (align: boolean): boolean => {
      if (this.#scope.destroyed || generation !== this.#locateFocusGeneration) return true;
      const row = this.#shadow.querySelector<HTMLElement>(`.hnr-comment[data-comment-id="${id}"]`);
      if (!row) return false;
      if (align) {
        const viewportTop = this.#commentViewport.getBoundingClientRect().top;
        const rowTop = row.getBoundingClientRect().top;
        const delta = rowTop - viewportTop;
        if (Math.abs(delta) > 0.5) this.#commentViewport.scrollTop += delta;
      }
      row.focus({ preventScroll: true });
      if (flash) this.#flashLocatedComment(row);
      return true;
    };
    queueMicrotask(() => {
      if (!focusMountedTarget(true)) {
        this.#virtualList.scrollToIndex(index);
        focusMountedTarget(true);
      }
      const view = this.document.defaultView;
      if (!view) return;
      this.#locateFocusFrame = view.requestAnimationFrame(() => {
        this.#locateFocusFrame = null;
        if (this.#scope.destroyed || generation !== this.#locateFocusGeneration) return;
        if (focusMountedTarget(false)) return;
        this.#virtualList.scrollToIndex(index);
        focusMountedTarget(true);
      });
    });
    return true;
  }

  #flashLocatedComment(row: HTMLElement): void {
    this.#clearLocatedCommentFlash();
    const id = Number.parseInt(row.dataset.commentId ?? "", 10) as CommentId;
    if (!Number.isSafeInteger(id)) return;
    this.#locateFlashId = id;
    row.removeAttribute("data-locate-flash");
    void row.offsetWidth;
    row.dataset.locateFlash = "true";
    this.#locateFlashTimer = this.document.defaultView?.setTimeout(() => {
      this.#clearLocatedCommentFlash();
    }, LOCATED_COMMENT_FLASH_MS) ?? null;
  }

  #restoreLocatedCommentFlash(): void {
    if (this.#locateFlashId === null) return;
    this.#shadow.querySelector<HTMLElement>(
      `.hnr-comment[data-comment-id="${this.#locateFlashId}"]`,
    )?.setAttribute("data-locate-flash", "true");
  }

  #clearLocatedCommentFlash(): void {
    if (this.#locateFlashTimer !== null) this.document.defaultView?.clearTimeout(this.#locateFlashTimer);
    this.#locateFlashTimer = null;
    if (this.#locateFlashId !== null) {
      this.#shadow.querySelector<HTMLElement>(
        `.hnr-comment[data-comment-id="${this.#locateFlashId}"]`,
      )?.removeAttribute("data-locate-flash");
    }
    this.#locateFlashId = null;
  }

  #pinLocatedComment(id: CommentId, insetPx = 0): void {
    this.#locatedCommentPinId = id;
    this.#locatedCommentPinInsetPx = insetPx;
    this.#armLocatedCommentPin(LOCATED_COMMENT_PIN_MS);
  }

  #extendLocatedCommentPin(): void {
    if (this.#locatedCommentPinId === null) return;
    this.#armLocatedCommentPin(LOCATED_COMMENT_SETTLE_MS);
    this.#scheduleLocatedCommentAlignment();
  }

  #armLocatedCommentPin(durationMs: number): void {
    if (this.#locatedCommentPinTimer !== null) this.document.defaultView?.clearTimeout(this.#locatedCommentPinTimer);
    this.#locatedCommentPinTimer = this.document.defaultView?.setTimeout(() => {
      this.#releaseLocatedCommentPin();
    }, durationMs) ?? null;
  }

  #scheduleLocatedCommentAlignment(): void {
    const id = this.#locatedCommentPinId;
    const view = this.document.defaultView;
    if (id === null || !view || this.#locatedCommentPinFrame !== null) return;
    this.#locatedCommentPinFrame = view.requestAnimationFrame(() => {
      this.#locatedCommentPinFrame = null;
      if (this.#scope.destroyed || this.#locatedCommentPinId !== id) return;
      let row = this.#shadow.querySelector<HTMLElement>(`.hnr-comment[data-comment-id="${id}"]`);
      if (!row) {
        const index = this.#visibleEntries.findIndex((entry) => entry.id === id);
        if (index < 0) return;
        this.#virtualList.scrollToIndex(index);
        row = this.#shadow.querySelector<HTMLElement>(`.hnr-comment[data-comment-id="${id}"]`);
      }
      if (!row) return;
      const targetTop = this.#commentViewport.getBoundingClientRect().top + this.#locatedCommentPinInsetPx;
      const delta = row.getBoundingClientRect().top - targetTop;
      if (Math.abs(delta) > 0.5) this.#commentViewport.scrollTop += delta;
      row.focus({ preventScroll: true });
      this.#restoreLocatedCommentFlash();
    });
  }

  #releaseLocatedCommentPin(): void {
    if (this.#locatedCommentPinTimer !== null) this.document.defaultView?.clearTimeout(this.#locatedCommentPinTimer);
    this.#locatedCommentPinTimer = null;
    if (this.#locatedCommentPinFrame !== null) this.document.defaultView?.cancelAnimationFrame(this.#locatedCommentPinFrame);
    this.#locatedCommentPinFrame = null;
    this.#locatedCommentPinId = null;
    this.#locatedCommentPinInsetPx = 0;
  }
}
