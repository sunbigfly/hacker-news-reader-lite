// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseHnDocument } from "../src/host/hn-dom-adapter";
import { LifecycleScope } from "../src/kernel/lifecycle";
import type { OfflineDownloadHistoryEntry } from "../src/offline/offline-history-repository";
import { DEFAULT_SETTINGS } from "../src/settings/settings-store";
import { ReaderView } from "../src/shell/reader-view";
import type { DiscussionSummaryHistoryEntry } from "../src/summary/summary-service";
import { CommentProjection } from "../src/thread/comment-projection";
import { CommentTree } from "../src/thread/comment-tree";

describe("ReaderView", () => {
  it("styles header tools from their lifecycle-owned expanded state", () => {
    const css = readFileSync(resolve("lite/styles/10-reader.css"), "utf8");
    expect(css).toMatch(/\.hnr-actions-content\s*\{[^}]*max-width: 0;/s);
    expect(css).toMatch(/\.hnr-header-actions\[data-expanded="true"\] \.hnr-actions-content,[^{]*\{[^}]*max-width: 310px;/s);
    expect(css).toMatch(/\.hnr-commands\s*\{[^}]*flex: 0 0 auto;/s);
    expect(css).toMatch(/\.hnr-header-actions\[data-expanded="true"\] \.hnr-actions-toggle svg,[^{]*\{[^}]*rotate\(180deg\);/s);
    expect(css).toMatch(/\.hnr-title-original, \.hnr-title-subtitle\s*\{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/s);
    expect(css).toMatch(/\.hnr-summary-window\s*\{[^}]*width: min\(660px,[^}]*height: min\(560px,/s);
  });

  it("fits the frozen original and translated titles to their current single-line width", () => {
    const previousResizeObserver = window.ResizeObserver;
    const observe = vi.fn();
    const disconnect = vi.fn();
    const resizeCallbacks: ResizeObserverCallback[] = [];
    class HeaderResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallbacks.push(callback);
      }
      observe = observe;
      disconnect = disconnect;
      unobserve = vi.fn();
    }
    Reflect.set(window, "ResizeObserver", HeaderResizeObserver);
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const computedStyle = vi.spyOn(window, "getComputedStyle");
    document.documentElement.innerHTML = readFileSync(resolve("lite/fixtures/hn-item.html"), "utf8");
    const snapshot = parseHnDocument(document);
    const scope = new LifecycleScope();
    const tree = new CommentTree(snapshot.story, snapshot.comments);
    const view = new ReaderView(document, tree, new CommentProjection(tree), true, {
      onClose: vi.fn(), onCommand: vi.fn(), onCommentAction: vi.fn(), onViewportCommentsChanged: vi.fn(), onToggleComment: vi.fn(), onLoadMissing: vi.fn(),
    }, scope, "", document.body);
    const titleJump = view.surfaceRoot.querySelector<HTMLElement>(".hnr-title-jump");
    const original = view.surfaceRoot.querySelector<HTMLElement>(".hnr-title-original");
    const subtitle = view.surfaceRoot.querySelector<HTMLElement>(".hnr-title-subtitle");
    if (!titleJump || !original || !subtitle) throw new Error("Reader title was not rendered");
    view.setTranslationEnabled(true);
    view.setTitleTranslation("这是一条需要自适应的超长译题");
    Object.defineProperty(titleJump, "clientWidth", { configurable: true, value: 180 });
    Object.defineProperty(original, "scrollWidth", {
      configurable: true,
      get: () => Math.ceil(300 * ((Number.parseFloat(original.style.fontSize) || 17) / 17)),
    });
    Object.defineProperty(subtitle, "scrollWidth", {
      configurable: true,
      get: () => Math.ceil(250 * ((Number.parseFloat(subtitle.style.fontSize) || 13) / 13)),
    });
    computedStyle.mockImplementation((element) => {
      if (element === original) return { fontSize: "17px" } as CSSStyleDeclaration;
      if (element === subtitle) return { fontSize: "13px" } as CSSStyleDeclaration;
      return { fontSize: "16px" } as CSSStyleDeclaration;
    });
    while (frames.length > 0) frames.shift()?.(0);

    expect(observe).toHaveBeenCalledWith(titleJump, undefined);
    expect(resizeCallbacks).not.toHaveLength(0);
    expect(Number.parseFloat(original.style.fontSize)).toBeCloseTo(10.2, 1);
    expect(Number.parseFloat(subtitle.style.fontSize)).toBeCloseTo(9.3, 1);
    scope.destroy();
    expect(disconnect).toHaveBeenCalled();
    requestFrame.mockRestore();
    computedStyle.mockRestore();
    if (previousResizeObserver) Reflect.set(window, "ResizeObserver", previousResizeObserver);
    else Reflect.deleteProperty(window, "ResizeObserver");
  });

  it("keeps Reader status announcements offscreen instead of rendering a banner", () => {
    const css = readFileSync(resolve("lite/styles/10-reader.css"), "utf8");
    expect(css).toMatch(/\.hnr-status\s*\{[^}]*position: absolute;[^}]*width: 1px;[^}]*height: 1px;/s);
    expect(css).toMatch(/\.hnr-status\s*\{[^}]*overflow: hidden;[^}]*clip-path: inset\(50%\);/s);
    expect(css).toMatch(/\.hnr-status\s*\{[^}]*padding: 0;[^}]*border: 0;/s);
    expect(css).toMatch(/\.hnr-locator-notice\s*\{[^}]*position: absolute;[^}]*border-radius: 999px;/s);
    expect(css).toMatch(/\.hnr-new-comments-notice\s*\{[^}]*position: absolute;[^}]*bottom: 16px;[^}]*left: 50%;/s);
    expect(css).toMatch(/\.hnr-new-comments-notice\s*\{[^}]*border-radius: 999px;[^}]*pointer-events: auto;/s);
  });

  it("consumes clicked new-comment notices while visible highlights expire after entering the viewport", async () => {
    vi.useFakeTimers();
    try {
      document.documentElement.innerHTML = readFileSync(resolve("lite/fixtures/hn-item.html"), "utf8");
      const snapshot = parseHnDocument(document);
      const ids = snapshot.comments.slice(0, 2).map((comment) => comment.id);
      if (ids.length < 2) throw new Error("Fixture did not contain two comments");
      const scope = new LifecycleScope();
      const tree = new CommentTree(snapshot.story, snapshot.comments);
      const view = new ReaderView(document, tree, new CommentProjection(tree), true, {
        onClose: vi.fn(), onCommand: vi.fn(), onCommentAction: vi.fn(), onViewportCommentsChanged: vi.fn(), onToggleComment: vi.fn(), onLoadMissing: vi.fn(),
      }, scope, "", document.body);

      view.announceNewComments(ids);
      const notice = view.surfaceRoot.querySelector<HTMLElement>(".hnr-new-comments-notice");
      const current = view.surfaceRoot.querySelector<HTMLButtonElement>(".hnr-new-comments-current");
      const next = view.surfaceRoot.querySelector<HTMLButtonElement>('[data-action="next-new-comment"]');
      const close = view.surfaceRoot.querySelector<HTMLButtonElement>('[data-action="dismiss-new-comments"]');
      expect(notice?.hidden).toBe(false);
      expect(notice?.textContent).toContain("新评论 1/2");
      expect(current?.dataset.commentId).toBe(String(ids[0]));
      for (const id of ids) {
        expect(view.surfaceRoot.querySelector<HTMLElement>(`.hnr-comment[data-comment-id="${id}"]`)?.dataset.newComment).toBe("true");
      }

      next?.click();
      expect(notice?.textContent).toContain("新评论 2/2");
      expect(current?.dataset.commentId).toBe(String(ids[1]));
      current?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, composed: true }));
      await Promise.resolve();
      expect(current?.dataset.commentId).toBe(String(ids[0]));
      expect(view.surfaceRoot.activeElement?.closest<HTMLElement>(".hnr-comment")?.dataset.commentId).toBe(String(ids[0]));

      current?.click();
      expect(notice?.hidden).toBe(false);
      expect(notice?.textContent).toContain("新评论 1/1");
      expect(current?.dataset.commentId).toBe(String(ids[1]));
      current?.click();
      expect(notice?.hidden).toBe(true);
      expect(current?.dataset.commentId).toBeUndefined();

      vi.advanceTimersByTime(4_999);
      expect(view.surfaceRoot.querySelector<HTMLElement>(`.hnr-comment[data-comment-id="${ids[0]}"]`)?.dataset.newComment).toBe("true");
      vi.advanceTimersByTime(1);
      for (const id of ids) {
        expect(view.surfaceRoot.querySelector<HTMLElement>(`.hnr-comment[data-comment-id="${id}"]`)?.hasAttribute("data-new-comment")).toBe(false);
      }
      view.announceNewComments(ids);
      expect(notice?.hidden).toBe(false);
      close?.click();
      expect(notice?.hidden).toBe(true);
      scope.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the located comment background flash on the exact row after a virtual remount", async () => {
    document.documentElement.innerHTML = readFileSync(resolve("lite/fixtures/hn-item.html"), "utf8");
    const snapshot = parseHnDocument(document);
    const scope = new LifecycleScope();
    const tree = new CommentTree(snapshot.story, snapshot.comments);
    const projection = new CommentProjection(tree);
    const view = new ReaderView(document, tree, projection, true, {
      onClose: vi.fn(), onCommand: vi.fn(), onCommentAction: vi.fn(), onViewportCommentsChanged: vi.fn(), onToggleComment: vi.fn(), onLoadMissing: vi.fn(),
    }, scope, "", document.body);
    const targetId = snapshot.comments[0]?.id;
    if (!targetId) throw new Error("Fixture did not contain a comment");

    expect(view.locateComment(targetId, true)).toBe(true);
    await Promise.resolve();
    const firstRow = view.surfaceRoot.querySelector<HTMLElement>(`.hnr-comment[data-comment-id="${targetId}"]`);
    expect(firstRow?.dataset.locateFlash).toBe("true");

    view.update(tree, projection, true);
    const remountedRow = view.surfaceRoot.querySelector<HTMLElement>(`.hnr-comment[data-comment-id="${targetId}"]`);
    expect(remountedRow).not.toBe(firstRow);
    expect(remountedRow?.dataset.locateFlash).toBe("true");
    scope.destroy();
  });

  it("aligns a reply elbow with the vertical center of its avatar", () => {
    const css = readFileSync(resolve("lite/styles/10-reader.css"), "utf8");
    expect(css).toMatch(/\.hnr-tree-elbow\s*\{[^}]*height: 25px;/s);
    expect(css).toMatch(/\.hnr-comment\[data-collapsed="true"\] \.hnr-tree-elbow\s*\{ height: 22px; \}/);
  });

  it("renders deterministic generated avatars as decorative inline SVG", () => {
    const previous: unknown = Reflect.get(globalThis, "multiavatar");
    function multiavatar(seed: string): string {
      return `<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h${seed.length}v1z"/></svg>`;
    }
    Reflect.set(globalThis, "multiavatar", multiavatar);
    try {
      document.documentElement.innerHTML = readFileSync(resolve("lite/fixtures/hn-item.html"), "utf8");
      const snapshot = parseHnDocument(document);
      const scope = new LifecycleScope();
      const tree = new CommentTree(snapshot.story, snapshot.comments);
      const view = new ReaderView(document, tree, new CommentProjection(tree), true, {
        onClose: vi.fn(), onCommand: vi.fn(), onCommentAction: vi.fn(), onViewportCommentsChanged: vi.fn(), onToggleComment: vi.fn(), onLoadMissing: vi.fn(),
      }, scope, "", document.body);
      const avatar = view.surfaceRoot.querySelector<SVGSVGElement>(".hnr-author-marker > .hnr-author-avatar");

      expect(avatar?.tagName.toLowerCase()).toBe("svg");
      expect(avatar?.hasAttribute("src")).toBe(false);
      expect(avatar?.getAttribute("aria-hidden")).toBe("true");
      expect(avatar?.getAttribute("focusable")).toBe("false");
      view.destroy();
      scope.destroy();
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, "multiavatar");
      else Reflect.set(globalThis, "multiavatar", previous);
    }
  });

  it("gives each vertical reply line a transparent collapse hit area", () => {
    const css = readFileSync(resolve("lite/styles/10-reader.css"), "utf8");
    expect(css).toMatch(/\.hnr-tree-collapse-hit\s*\{[^}]*pointer-events: auto;[^}]*cursor: pointer;/s);
    expect(css).toMatch(/\.hnr-tree-collapse-hit::after\s*\{[^}]*left: -5px;[^}]*width: 11px;[^}]*background: transparent;/s);
  });

  it("keeps header tools expanded for one second after pointer leave", () => {
    vi.useFakeTimers();
    try {
      document.documentElement.innerHTML = readFileSync(resolve("lite/fixtures/hn-item.html"), "utf8");
      const snapshot = parseHnDocument(document);
      const scope = new LifecycleScope();
      const tree = new CommentTree(snapshot.story, snapshot.comments);
      const view = new ReaderView(document, tree, new CommentProjection(tree), true, {
        onClose: vi.fn(),
        onCommand: vi.fn(),
        onCommentAction: vi.fn(),
        onViewportCommentsChanged: vi.fn(),
        onToggleComment: vi.fn(),
        onLoadMissing: vi.fn(),
      }, scope, "", document.body);
      const headerActions = view.surfaceRoot.querySelector<HTMLElement>(".hnr-header-actions");
      if (!headerActions) throw new Error("Reader header actions were not rendered");
      expect(headerActions.dataset.expanded).toBe("false");
      headerActions.dispatchEvent(new Event("pointerenter"));
      expect(headerActions.dataset.expanded).toBe("true");
      headerActions.dispatchEvent(new Event("pointerleave"));
      vi.advanceTimersByTime(999);
      expect(headerActions.dataset.expanded).toBe("true");
      vi.advanceTimersByTime(1);
      expect(headerActions.dataset.expanded).toBe("false");
      view.destroy();
      scope.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens an accessible summary window with factual visualization and story history", async () => {
    document.documentElement.innerHTML = readFileSync(resolve("lite/fixtures/hn-item.html"), "utf8");
    const snapshot = parseHnDocument(document);
    const scope = new LifecycleScope();
    const tree = new CommentTree(snapshot.story, snapshot.comments);
    const onRun = vi.fn();
    const onSelect = vi.fn();
    const onDownload = vi.fn();
    const onDeleteDownload = vi.fn();
    const onOpenTopic = vi.fn();
    const view = new ReaderView(document, tree, new CommentProjection(tree), true, {
      onClose: vi.fn(), onCommand: vi.fn(), onCommentAction: vi.fn(), onViewportCommentsChanged: vi.fn(), onToggleComment: vi.fn(), onLoadMissing: vi.fn(),
    }, scope, "", document.body);
    const entry = (
      id: string,
      overview: string,
      savedAt: number,
      summaryScope: DiscussionSummaryHistoryEntry["scope"] = { kind: "all" },
    ): DiscussionSummaryHistoryEntry => ({
      id,
      storyId: snapshot.story.id,
      storyTitle: snapshot.story.title,
      scope: summaryScope,
      length: id === "latest" ? "standard" : "short",
      model: "gpt-test",
      savedAt,
      summary: {
        kind: "discussion",
        overview,
        consensus: ["保留 DOM-first", "避免轮询"],
        disputes: ["刷新粒度"],
        branches: [{ commentId: 101 as never, summary: "该分支讨论加载策略" }],
        coverageNote: "输入预算覆盖了主要评论。",
        includedComments: 3,
        availableComments: 4,
      },
    });
    const currentEntry = entry("latest", "当前讨论主要关注轻量加载。", Date.UTC(2026, 7, 17, 8));
    const otherEntry: DiscussionSummaryHistoryEntry = {
      ...entry("older", "其他帖子的分支总结。", Date.UTC(2026, 7, 17, 9), { kind: "branch", rootId: 101 as never }),
      storyId: 999 as never,
      storyTitle: "Another summarized topic",
    };
    const history = [otherEntry, currentEntry];
    const downloadEntry: OfflineDownloadHistoryEntry = {
      id: "offline-1",
      storyId: snapshot.story.id,
      storyTitle: snapshot.story.title,
      filename: "story.html",
      savedAt: Date.UTC(2026, 7, 17, 10),
      bytes: 12_345,
      commentCount: 4,
      translatedCount: 3,
    };
    const topicHistory = [{
      storyId: 999 as never,
      storyTitle: "Another browsed topic",
      visitedAt: Date.UTC(2026, 7, 17, 11),
      position: { commentId: 901 as never, offset: 24 },
      collapsedCommentCount: 2,
    }, {
      storyId: snapshot.story.id,
      storyTitle: snapshot.story.title,
      visitedAt: Date.UTC(2026, 7, 17, 10),
      position: { commentId: 101 as never, offset: 12 },
      collapsedCommentCount: 1,
    }];

    view.openReaderWorkbench(history, [downloadEntry], topicHistory, {
      onRunSummary: onRun,
      onSelectSummary: onSelect,
      onDownload,
      onDeleteDownload,
      onOpenTopic,
    }, "insight", currentEntry, {
      storyTitle: snapshot.story.title,
      stage: "generating",
      status: "running",
      complete: 5,
      total: 5,
      message: "正在生成离线 HTML。",
    });
    const dialog = view.surfaceRoot.querySelector<HTMLElement>(".hnr-summary-window");
    expect(dialog?.getAttribute("role")).toBe("dialog");
    expect(dialog?.getAttribute("aria-modal")).toBe("false");
    const workbenchClose = dialog?.querySelector<HTMLButtonElement>(".hnr-summary-window-close");
    const workbenchCloseTooltip = workbenchClose?.querySelector<HTMLElement>(".hnr-tooltip");
    expect(workbenchClose?.hasAttribute("title")).toBe(false);
    expect(workbenchCloseTooltip?.textContent).toBe("关闭阅读工作台");
    expect(workbenchClose?.getAttribute("aria-describedby")).toBe(workbenchCloseTooltip?.id);
    expect(view.surfaceRoot.querySelector<HTMLElement>(".hnr-summary-coverage-ring")?.getAttribute("aria-label"))
      .toContain("3/4 条评论，75%");
    expect([...view.surfaceRoot.querySelectorAll(".hnr-summary-metric strong")].map((node) => node.textContent))
      .toEqual(["2", "1", "1"]);
    expect(onSelect).toHaveBeenCalledWith(currentEntry);

    view.surfaceRoot.querySelector<HTMLButtonElement>('[data-summary-tab="summary-history"]')?.click();
    expect(view.surfaceRoot.querySelector<HTMLElement>('.hnr-summary-pane[data-summary-pane="summary-history"]')?.hidden).toBe(false);
    expect(view.surfaceRoot.querySelectorAll(".hnr-summary-history-entry")).toHaveLength(2);
    expect(view.surfaceRoot.querySelector(".hnr-summary-history-heading")?.textContent).toContain("全部讨论总结历史");
    expect([...view.surfaceRoot.querySelectorAll(".hnr-summary-history-story")].map((node) => node.textContent))
      .toEqual(["Another summarized topic", snapshot.story.title]);
    view.surfaceRoot.querySelectorAll<HTMLButtonElement>(".hnr-summary-history-entry")[0]?.click();
    expect(view.surfaceRoot.querySelector(".hnr-summary-overview")?.textContent).toContain("其他帖子的分支总结");
    expect(view.surfaceRoot.querySelector(".hnr-summary-heading p")?.textContent).toBe("Another summarized topic");
    expect(view.surfaceRoot.querySelector<HTMLAnchorElement>("a.hnr-summary-branch")?.target).toBe("_blank");
    expect(onSelect).toHaveBeenLastCalledWith(otherEntry);

    const summaryForm = view.surfaceRoot.querySelector<HTMLFormElement>(".hnr-summary-controls");
    summaryForm?.requestSubmit();
    expect(onRun).toHaveBeenCalledWith({ kind: "all" }, "standard");

    view.surfaceRoot.querySelector<HTMLButtonElement>('[data-summary-tab="downloads"]')?.click();
    expect(view.surfaceRoot.querySelector('.hnr-download-stage[data-stage="generating"]')?.getAttribute("data-state")).toBe("active");
    expect(view.surfaceRoot.querySelector(".hnr-download-history-detail")?.textContent).toContain("story.html");
    const downloadAction = view.surfaceRoot.querySelector<HTMLButtonElement>(".hnr-download-history-action");
    const downloadTooltip = downloadAction?.querySelector<HTMLElement>(".hnr-tooltip");
    expect(downloadAction?.hasAttribute("title")).toBe(false);
    expect(downloadTooltip?.textContent).toBe("再次下载 story.html");
    expect(downloadAction?.getAttribute("aria-describedby")).toBe(downloadTooltip?.id);
    downloadAction?.click();
    expect(onDownload).toHaveBeenCalledWith(downloadEntry);
    const deleteAction = view.surfaceRoot.querySelector<HTMLButtonElement>(".hnr-download-history-delete");
    deleteAction?.click();
    expect(onDeleteDownload).not.toHaveBeenCalled();
    expect(deleteAction?.dataset.confirm).toBe("true");
    deleteAction?.click();
    expect(onDeleteDownload).toHaveBeenCalledWith(downloadEntry);

    view.surfaceRoot.querySelector<HTMLButtonElement>('[data-summary-tab="browsing-history"]')?.click();
    expect(view.surfaceRoot.querySelectorAll(".hnr-browsing-history-entry")).toHaveLength(2);
    const historySearch = view.surfaceRoot.querySelector<HTMLInputElement>(".hnr-browsing-history-search");
    if (!historySearch) throw new Error("browsing history search was not rendered");
    historySearch.value = "901";
    historySearch.dispatchEvent(new Event("input"));
    expect([...view.surfaceRoot.querySelectorAll<HTMLElement>(".hnr-browsing-history-entry")]
      .filter((entryNode) => !entryNode.hidden)).toHaveLength(1);
    view.surfaceRoot.querySelector<HTMLButtonElement>('.hnr-browsing-history-entry[data-story-id="999"]')?.click();
    expect(onOpenTopic).toHaveBeenCalledWith(999);

    view.surfaceRoot.querySelector<HTMLButtonElement>('[data-summary-tab="summary-history"]')?.click();
    view.surfaceRoot.querySelectorAll<HTMLButtonElement>(".hnr-summary-history-entry")[1]?.click();
    view.surfaceRoot.querySelector<HTMLElement>("button.hnr-summary-branch > span:nth-child(2)")?.click();
    await Promise.resolve();
    expect(view.surfaceRoot.querySelector(".hnr-summary-window")).toBeNull();
    expect(view.surfaceRoot.activeElement?.getAttribute("data-comment-id")).toBe("101");
    scope.destroy();
  });

  it("closes the reading workbench with Escape or an outside blank click without dismissing inner clicks", async () => {
    document.documentElement.innerHTML = readFileSync(resolve("lite/fixtures/hn-item.html"), "utf8");
    const snapshot = parseHnDocument(document);
    const scope = new LifecycleScope();
    const tree = new CommentTree(snapshot.story, snapshot.comments);
    const view = new ReaderView(document, tree, new CommentProjection(tree), true, {
      onClose: vi.fn(), onCommand: vi.fn(), onCommentAction: vi.fn(), onViewportCommentsChanged: vi.fn(), onToggleComment: vi.fn(), onLoadMissing: vi.fn(),
    }, scope, "", document.body);
    const trigger = view.surfaceRoot.querySelector<HTMLButtonElement>('[data-command="history"]');
    if (!trigger) throw new Error("history trigger was not rendered");
    const callbacks = {
      onRunSummary: vi.fn(),
      onSelectSummary: vi.fn(),
      onDownload: vi.fn(),
      onDeleteDownload: vi.fn(),
      onOpenTopic: vi.fn(),
    };

    trigger.focus();
    view.openReaderWorkbench([], [], [], callbacks, "browsing-history");
    await Promise.resolve();
    view.surfaceRoot.querySelector<HTMLElement>(".hnr-summary-window")?.click();
    expect(view.surfaceRoot.querySelector(".hnr-summary-float-layer")).not.toBeNull();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(view.surfaceRoot.querySelector(".hnr-summary-float-layer")).toBeNull();
    expect(view.surfaceRoot.activeElement).toBe(trigger);

    view.openReaderWorkbench([], [], [], callbacks, "browsing-history");
    await Promise.resolve();
    view.surfaceRoot.querySelector<HTMLElement>(".hnr-summary-float-layer")?.click();
    expect(view.surfaceRoot.querySelector(".hnr-summary-float-layer")).toBeNull();
    expect(view.surfaceRoot.activeElement).toBe(trigger);
    scope.destroy();
  });

  it("mounts a bounded accessible tree and cleans 20 cycles", () => {
    document.documentElement.innerHTML = readFileSync(resolve("lite/fixtures/hn-item.html"), "utf8");
    const snapshot = parseHnDocument(document);
    const rootScope = new LifecycleScope();
    for (let cycle = 0; cycle < 20; cycle += 1) {
      const tree = new CommentTree(snapshot.story, snapshot.comments);
      const projection = new CommentProjection(tree);
      const onCommentAction = vi.fn();
      const view = new ReaderView(document, tree, projection, true, {
        onClose: vi.fn(),
        onCommand: vi.fn(),
        onCommentAction,
        onViewportCommentsChanged: vi.fn(),
        onToggleComment: vi.fn(),
        onLoadMissing: vi.fn(),
      }, rootScope, "", document.body);
      const nativeComments = document.querySelector<HTMLElement>("table.comment-tree");
      const nativeReplyRow = document.querySelector<HTMLFormElement>('form[action="comment"]')?.closest<HTMLElement>("tr");
      expect(view.mountedCommentCount).toBeLessThanOrEqual(120);
      expect(document.querySelectorAll("#hn-reader-root")).toHaveLength(1);
      expect(nativeComments?.hidden).toBe(false);
      expect(nativeReplyRow?.hidden).toBe(false);
      expect(view.surfaceRoot.querySelector(".hnr-shell")?.getAttribute("role")).toBe("region");
      expect(view.surfaceRoot.querySelector(".hnr-shell")?.hasAttribute("aria-modal")).toBe(false);
      expect(view.surfaceRoot.querySelector("script")).toBeNull();
      expect(view.surfaceRoot.querySelector(".hnr-footer")).toBeNull();
      const commands = [...view.surfaceRoot.querySelectorAll<HTMLButtonElement>(".hnr-command")];
      expect(commands).toHaveLength(7);
      expect(commands.every((button) => !button.hasAttribute("title"))).toBe(true);
      expect(commands.every((button) => {
        const tooltip = button.querySelector<HTMLElement>(".hnr-tooltip");
        return button.querySelector("svg") !== null
          && tooltip?.textContent === button.getAttribute("aria-label")
          && tooltip.getAttribute("role") === "tooltip"
          && button.getAttribute("aria-describedby") === tooltip.id;
      })).toBe(true);
      const headerActions = view.surfaceRoot.querySelector<HTMLElement>(".hnr-header-actions");
      expect([...headerActions?.children ?? []].map((element) => element.className)).toEqual(["hnr-actions-toggle", "hnr-actions-content"]);
      expect(headerActions?.querySelector(".hnr-actions-toggle")?.getAttribute("aria-hidden")).toBe("true");
      expect(headerActions?.querySelectorAll(".hnr-actions-content > :is(.hnr-commands, .hnr-original-control, .hnr-close)")).toHaveLength(3);
      expect(view.surfaceRoot.querySelector<HTMLButtonElement>(".hnr-close")?.getAttribute("aria-label")).toBe("退出阅读");
      expect(view.surfaceRoot.querySelector(".hnr-meta")).toBeNull();
      expect(view.surfaceRoot.querySelector(".hnr-header > .hnr-coverage")?.textContent).toContain("条评论");
      const titleJump = view.surfaceRoot.querySelector<HTMLAnchorElement>(".hnr-title-jump");
      const titleJumpTooltip = titleJump?.querySelector<HTMLElement>(".hnr-tooltip");
      expect(titleJump?.hasAttribute("title")).toBe(false);
      expect(titleJump?.getAttribute("aria-label")).toBe("单击回到评论顶部；Ctrl 或 Command 加鼠标左键打开外链");
      expect(titleJumpTooltip?.textContent).toBe("单击回顶 · Ctrl + 🖱️左键打开外链");
      expect(titleJump?.getAttribute("aria-describedby")).toBe(titleJumpTooltip?.id);
      expect(titleJump?.href).toBe(snapshot.story.url);
      expect(titleJump?.target).toBe("_blank");
      expect(titleJump?.rel).toBe("noopener noreferrer");
      const titleSubtitle = view.surfaceRoot.querySelector<HTMLElement>(".hnr-title-subtitle");
      expect(titleSubtitle?.hidden).toBe(true);
      view.setTitleTranslation("测试故事译题");
      expect(titleSubtitle?.hidden).toBe(true);
      view.setTranslationEnabled(true);
      expect(titleSubtitle?.textContent).toBe("测试故事译题");
      expect(titleSubtitle?.hidden).toBe(false);
      view.setTranslationEnabled(false);
      expect(titleSubtitle?.hidden).toBe(true);
      const originalControl = view.surfaceRoot.querySelector<HTMLAnchorElement>(".hnr-original-control");
      expect(originalControl?.getAttribute("aria-label")).toBe("回到原帖");
      expect(originalControl?.hasAttribute("title")).toBe(false);
      expect(new URL(originalControl?.href ?? "").searchParams.get("hnr_native")).toBe("1");
      const commentActions = [...view.surfaceRoot.querySelectorAll<HTMLElement>('[data-comment-id="101"] .hnr-comment-action')];
      expect(commentActions).toHaveLength(5);
      expect(commentActions[0]?.getAttribute("aria-label")).toBe("收起此分支");
      expect(commentActions.every((action) => {
        const tooltip = action.querySelector<HTMLElement>(".hnr-tooltip");
        return !action.hasAttribute("title")
          && tooltip?.textContent === action.getAttribute("aria-label")
          && tooltip.getAttribute("role") === "tooltip"
          && action.getAttribute("aria-describedby") === tooltip.id;
      })).toBe(true);
      const branchToggle = view.surfaceRoot.querySelector<HTMLButtonElement>('[data-comment-id="101"] .hnr-branch-toggle');
      const branchTooltip = branchToggle?.querySelector<HTMLElement>(".hnr-tooltip");
      expect(branchToggle?.hasAttribute("title")).toBe(false);
      expect(branchTooltip?.textContent).toBe(branchToggle?.getAttribute("aria-label"));
      expect(branchToggle?.getAttribute("aria-describedby")).toBe(branchTooltip?.id);
      const translateComment = view.surfaceRoot.querySelector<HTMLButtonElement>('[data-comment-id="101"] [data-comment-action="translate-comment"]');
      expect(translateComment?.getAttribute("aria-label")).toBe("翻译此评论");
      translateComment?.click();
      expect(onCommentAction).toHaveBeenCalledWith("translate-comment", 101);
      view.setTranslation(101 as never, "已翻译", "<p>已翻译</p>", "<p>已翻译</p>");
      expect(translateComment?.getAttribute("aria-label")).toBe("重新翻译此评论");
      expect(translateComment?.querySelector(".hnr-tooltip")?.textContent).toBe("重新翻译此评论");
      translateComment?.click();
      expect(onCommentAction).toHaveBeenLastCalledWith("translate-comment", 101);
      view.surfaceRoot.querySelector<HTMLButtonElement>('[data-comment-id="101"] [data-comment-action="reply"]')?.click();
      expect(onCommentAction).toHaveBeenCalledWith("reply", 101);
      expect(view.surfaceRoot.querySelector<HTMLAnchorElement>(".hnr-comment-body a")?.target).toBe("_blank");
      expect(view.surfaceRoot.querySelector('[data-comment-id="101"] .hnr-tree-elbow')).toBeNull();
      expect(view.surfaceRoot.querySelector('[data-comment-id="101"] .hnr-tree-stem')).not.toBeNull();
      expect(view.surfaceRoot.querySelector('[data-comment-id="102"] .hnr-tree-elbow')).not.toBeNull();
      expect(view.surfaceRoot.querySelector('[data-comment-id="102"] .hnr-tree-rail')?.getAttribute("data-continues")).toBe("false");
      expect(view.surfaceRoot.querySelector('[data-comment-id="103"]')?.querySelectorAll('.hnr-tree-rail[data-continues="false"]')).toHaveLength(2);
      expect(view.surfaceRoot.querySelector('[data-comment-id="103"] .hnr-tree-rail[data-current-parent="true"]')).not.toBeNull();
      expect(view.surfaceRoot.querySelector('[data-comment-id="103"] .hnr-tree-stem')).toBeNull();
      expect(view.surfaceRoot.querySelector('[data-comment-id="104"] .hnr-tree-elbow')).toBeNull();
      expect(view.surfaceRoot.querySelector('[data-comment-id="101"]')?.getAttribute("data-has-children")).toBe("true");
      const viewport = view.surfaceRoot.querySelector<HTMLElement>(".hnr-comments");
      if (!titleJump || !viewport) throw new Error("Reader title jump was not rendered");
      viewport.scrollTop = 640;
      const jumpClick = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true });
      titleJump.dispatchEvent(jumpClick);
      expect(jumpClick.defaultPrevented).toBe(true);
      expect(viewport.scrollTop).toBe(0);
      viewport?.focus();
      viewport?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, composed: true }));
      expect(view.surfaceRoot.activeElement?.classList.contains("hnr-comment")).toBe(true);
      view.destroy();
      expect(document.querySelectorAll("#hn-reader-root")).toHaveLength(0);
      expect(nativeComments?.hidden).toBe(false);
      expect(nativeReplyRow?.hidden).toBe(false);
    }
    rootScope.destroy();
  });

  it("collapses a branch from its trunk control and retires success notices", () => {
    vi.useFakeTimers();
    try {
      document.documentElement.innerHTML = readFileSync(resolve("lite/fixtures/hn-item.html"), "utf8");
      const snapshot = parseHnDocument(document);
      const scope = new LifecycleScope();
      const tree = new CommentTree(snapshot.story, snapshot.comments);
      const projection = new CommentProjection(tree);
      const view = new ReaderView(document, tree, projection, true, {
        onClose: vi.fn(),
        onCommand: vi.fn(),
        onCommentAction: vi.fn(),
        onViewportCommentsChanged: vi.fn(),
        onToggleComment: (id) => {
          projection.toggle(id);
          view.update(tree, projection, true);
        },
        onLoadMissing: vi.fn(),
      }, scope, "", document.body);
      view.surfaceRoot.querySelector<HTMLButtonElement>('[data-comment-id="101"] .hnr-comment-actions [aria-label="收起此分支"]')?.click();
      expect(view.surfaceRoot.querySelector('[data-comment-id="102"]')).toBeNull();
      expect(view.surfaceRoot.querySelector<HTMLElement>('[data-comment-id="101"]')?.dataset.collapsed).toBe("true");
      expect(view.surfaceRoot.querySelector<HTMLElement>('[data-comment-id="101"] .hnr-comment-body')?.hidden).toBe(true);
      expect(view.surfaceRoot.querySelector<HTMLElement>('[data-comment-id="101"] .hnr-comment-actions')?.hidden).toBe(true);
      expect(view.surfaceRoot.querySelector('[data-comment-id="101"] .hnr-branch-toggle')?.getAttribute("aria-label")).toBe("展开分支");
      expect(view.surfaceRoot.querySelector('[data-comment-id="101"] .hnr-comment-actions [data-action="toggle-comment"]')?.getAttribute("aria-label")).toBe("展开此分支");

      view.setStatus("全帖预热完成", "success");
      const status = view.surfaceRoot.querySelector<HTMLElement>(".hnr-status");
      expect(status?.hidden).toBe(false);
      vi.advanceTimersByTime(4_000);
      expect(status?.hidden).toBe(true);
      scope.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("collapses the owning branch when its vertical reply line is clicked", () => {
    document.documentElement.innerHTML = readFileSync(resolve("lite/fixtures/hn-item.html"), "utf8");
    const snapshot = parseHnDocument(document);
    const scope = new LifecycleScope();
    const tree = new CommentTree(snapshot.story, snapshot.comments);
    const projection = new CommentProjection(tree);
    const onToggleComment = vi.fn();
    const view = new ReaderView(document, tree, projection, true, {
      onClose: vi.fn(),
      onCommand: vi.fn(),
      onCommentAction: vi.fn(),
      onViewportCommentsChanged: vi.fn(),
      onToggleComment: (id) => {
        onToggleComment(id);
        projection.toggle(id);
        view.update(tree, projection, true);
      },
      onLoadMissing: vi.fn(),
    }, scope, "", document.body);
    const stem = view.surfaceRoot.querySelector<HTMLElement>('[data-comment-id="101"] .hnr-tree-stem');
    expect(stem?.dataset.action).toBe("toggle-comment");
    expect(stem?.dataset.commentId).toBe("101");
    expect(view.surfaceRoot.querySelector<HTMLElement>('[data-comment-id="103"] .hnr-tree-rail')?.dataset.commentId).toBe("101");

    stem?.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));

    expect(onToggleComment).toHaveBeenCalledWith(101);
    expect(view.surfaceRoot.querySelector('[data-comment-id="102"]')).toBeNull();
    expect(view.surfaceRoot.querySelector<HTMLElement>('[data-comment-id="101"]')?.dataset.collapsed).toBe("true");
    scope.destroy();
  });

  it("keeps the collapsed parent anchored when its branch height disappears", () => {
    document.documentElement.innerHTML = readFileSync(resolve("lite/fixtures/hn-item.html"), "utf8");
    const snapshot = parseHnDocument(document);
    const scope = new LifecycleScope();
    const tree = new CommentTree(snapshot.story, snapshot.comments);
    const projection = new CommentProjection(tree);
    const view = new ReaderView(document, tree, projection, true, {
      onClose: vi.fn(),
      onCommand: vi.fn(),
      onCommentAction: vi.fn(),
      onViewportCommentsChanged: vi.fn(),
      onToggleComment: (id) => {
        projection.toggle(id);
        view.update(tree, projection, true);
      },
      onLoadMissing: vi.fn(),
    }, scope, "", document.body);
    const viewport = view.surfaceRoot.querySelector<HTMLElement>(".hnr-comments");
    expect(viewport).not.toBeNull();
    if (!viewport) return;
    viewport.scrollTop = 300;
    const rect = (top: number, height: number): DOMRect => ({
      x: 0, y: top, top, right: 800, bottom: top + height, left: 0,
      width: 800, height, toJSON: () => ({}),
    });
    const geometry = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === viewport) return rect(100, 400);
      if (this.dataset.commentId === "101") return projection.isCollapsed(101 as never) ? rect(0, 44) : rect(220, 300);
      if (this.dataset.commentId === "104") return rect(620, 64);
      return rect(0, 0);
    });
    try {
      view.surfaceRoot.querySelector<HTMLButtonElement>('[data-comment-id="101"] .hnr-comment-actions [aria-label="收起此分支"]')?.click();
      expect(view.surfaceRoot.querySelector('[data-comment-id="102"]')).toBeNull();
      expect(viewport.scrollTop).toBe(80);
    } finally {
      geometry.mockRestore();
      scope.destroy();
    }
  });

  it.each([
    ["above", 40],
    ["below", 520],
  ])("moves an expanded parent %s the viewport to the frozen-header inset when collapsed", (_position, parentTop) => {
    document.documentElement.innerHTML = readFileSync(resolve("lite/fixtures/hn-item.html"), "utf8");
    const snapshot = parseHnDocument(document);
    const scope = new LifecycleScope();
    const tree = new CommentTree(snapshot.story, snapshot.comments);
    const projection = new CommentProjection(tree);
    const view = new ReaderView(document, tree, projection, true, {
      onClose: vi.fn(),
      onCommand: vi.fn(),
      onCommentAction: vi.fn(),
      onViewportCommentsChanged: vi.fn(),
      onToggleComment: (id) => {
        projection.toggle(id);
        view.update(tree, projection, true);
      },
      onLoadMissing: vi.fn(),
    }, scope, "", document.body);
    const viewport = view.surfaceRoot.querySelector<HTMLElement>(".hnr-comments");
    expect(viewport).not.toBeNull();
    if (!viewport) return;
    viewport.scrollTop = 300;
    const rect = (top: number, height: number): DOMRect => ({
      x: 0, y: top, top, right: 800, bottom: top + height, left: 0,
      width: 800, height, toJSON: () => ({}),
    });
    const geometry = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === viewport) return rect(100, 400);
      if (this.dataset.commentId === "101") return projection.isCollapsed(101 as never) ? rect(0, 44) : rect(parentTop, 300);
      if (this.dataset.commentId === "104") return rect(620, 64);
      return rect(0, 0);
    });
    try {
      view.surfaceRoot.querySelector<HTMLButtonElement>('[data-comment-id="101"] .hnr-comment-actions [aria-label="收起此分支"]')?.click();
      expect(view.surfaceRoot.querySelector('[data-comment-id="102"]')).toBeNull();
      expect(viewport.scrollTop).toBe(185);
    } finally {
      geometry.mockRestore();
      scope.destroy();
    }
  });

  it("mounts an offscreen branch owner at the frozen-header inset when its visible descendant rail is collapsed", () => {
    document.documentElement.innerHTML = readFileSync(resolve("lite/fixtures/hn-item.html"), "utf8");
    const snapshot = parseHnDocument(document);
    const scope = new LifecycleScope();
    const tree = new CommentTree(snapshot.story, snapshot.comments);
    const projection = new CommentProjection(tree);
    const view = new ReaderView(document, tree, projection, true, {
      onClose: vi.fn(),
      onCommand: vi.fn(),
      onCommentAction: vi.fn(),
      onViewportCommentsChanged: vi.fn(),
      onToggleComment: (id) => {
        projection.toggle(id);
        view.update(tree, projection, true);
      },
      onLoadMissing: vi.fn(),
    }, scope, "", document.body);
    const viewport = view.surfaceRoot.querySelector<HTMLElement>(".hnr-comments");
    const owner = view.surfaceRoot.querySelector<HTMLElement>('[data-comment-id="101"]');
    const descendantRail = view.surfaceRoot.querySelector<HTMLElement>('[data-comment-id="103"] .hnr-tree-rail[data-comment-id="101"]');
    expect(viewport).not.toBeNull();
    expect(owner).not.toBeNull();
    expect(descendantRail).not.toBeNull();
    if (!viewport || !owner || !descendantRail) return;
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    viewport.scrollTop = 300;
    owner.remove();
    let collapsedLayoutOffset = 300;
    const rect = (top: number, height: number): DOMRect => ({
      x: 0, y: top, top, right: 800, bottom: top + height, left: 0,
      width: 800, height, toJSON: () => ({}),
    });
    const geometry = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === viewport) return rect(100, 400);
      if (this.dataset.commentId === "101") return rect(collapsedLayoutOffset - viewport.scrollTop, 44);
      return rect(0, 0);
    });
    try {
      descendantRail.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
      expect(view.surfaceRoot.querySelector('[data-comment-id="102"]')).toBeNull();
      expect(view.surfaceRoot.querySelector<HTMLElement>('[data-comment-id="101"]')?.dataset.collapsed).toBe("true");
      expect(viewport.scrollTop).toBe(185);
      collapsedLayoutOffset += 68;
      frames.shift()?.(0);
      expect(viewport.scrollTop).toBe(253);
      frames.shift()?.(16);
      expect(viewport.scrollTop).toBe(253);
      view.surfaceRoot.querySelector<HTMLElement>('[data-comment-id="101"]')?.remove();
      view.setTranslation(104 as never, "translated");
      frames.shift()?.(32);
      expect(view.surfaceRoot.querySelector<HTMLElement>('[data-comment-id="101"]')?.dataset.collapsed).toBe("true");
      expect(viewport.scrollTop).toBe(253);
    } finally {
      geometry.mockRestore();
      requestFrame.mockRestore();
      scope.destroy();
    }
  });

  it("keeps the collapsed parent fixed while its descendants expand downward", () => {
    document.documentElement.innerHTML = readFileSync(resolve("lite/fixtures/hn-item.html"), "utf8");
    const snapshot = parseHnDocument(document);
    const scope = new LifecycleScope();
    const tree = new CommentTree(snapshot.story, snapshot.comments);
    const projection = new CommentProjection(tree);
    projection.toggle(101 as never);
    const view = new ReaderView(document, tree, projection, true, {
      onClose: vi.fn(),
      onCommand: vi.fn(),
      onCommentAction: vi.fn(),
      onViewportCommentsChanged: vi.fn(),
      onToggleComment: (id) => {
        projection.toggle(id);
        view.update(tree, projection, true);
      },
      onLoadMissing: vi.fn(),
    }, scope, "", document.body);
    const viewport = view.surfaceRoot.querySelector<HTMLElement>(".hnr-comments");
    const expand = view.surfaceRoot.querySelector<HTMLButtonElement>('[data-comment-id="101"] .hnr-branch-toggle[aria-label="展开分支"]');
    expect(viewport).not.toBeNull();
    expect(expand).not.toBeNull();
    if (!viewport || !expand) return;
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    viewport.scrollTop = 300;
    let parentLayoutOffset = 520;
    const rect = (top: number, height: number): DOMRect => ({
      x: 0, y: top, top, right: 800, bottom: top + height, left: 0,
      width: 800, height, toJSON: () => ({}),
    });
    const geometry = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === viewport) return rect(100, 400);
      if (this.dataset.commentId === "101") return rect(parentLayoutOffset - viewport.scrollTop, projection.isCollapsed(101 as never) ? 44 : 300);
      return rect(0, 0);
    });
    try {
      expand.click();
      expect(view.surfaceRoot.querySelector('[data-comment-id="102"]')).not.toBeNull();
      expect(viewport.scrollTop).toBe(300);
      parentLayoutOffset += 68;
      frames.shift()?.(0);
      expect(viewport.scrollTop).toBe(368);
      frames.shift()?.(16);
      expect(viewport.scrollTop).toBe(368);
    } finally {
      geometry.mockRestore();
      requestFrame.mockRestore();
      scope.destroy();
    }
  });

  it("does not report the same mounted translation window again when a translation is rendered", async () => {
    document.documentElement.innerHTML = readFileSync(resolve("lite/fixtures/hn-item.html"), "utf8");
    const snapshot = parseHnDocument(document);
    const scope = new LifecycleScope();
    const tree = new CommentTree(snapshot.story, snapshot.comments);
    const projection = new CommentProjection(tree);
    const onViewportCommentsChanged = vi.fn();
    const view = new ReaderView(document, tree, projection, true, {
      onClose: vi.fn(),
      onCommand: vi.fn(),
      onCommentAction: vi.fn(),
      onViewportCommentsChanged,
      onToggleComment: vi.fn(),
      onLoadMissing: vi.fn(),
    }, scope, "", document.body);
    await Promise.resolve();
    const reportsBeforeTranslation = onViewportCommentsChanged.mock.calls.length;

    view.setTranslation(101 as never, "译文", "<p>译文</p>", "<p>译文</p>");
    await Promise.resolve();

    expect(reportsBeforeTranslation).toBeGreaterThan(0);
    expect(onViewportCommentsChanged).toHaveBeenCalledTimes(reportsBeforeTranslation);
    scope.destroy();
  });

  it("renders an optimistic translation without treating it as a completed cache record", () => {
    document.documentElement.innerHTML = readFileSync(resolve("lite/fixtures/hn-item.html"), "utf8");
    const snapshot = parseHnDocument(document);
    const scope = new LifecycleScope();
    const tree = new CommentTree(snapshot.story, snapshot.comments);
    const view = new ReaderView(document, tree, new CommentProjection(tree), true, {
      onClose: vi.fn(), onCommand: vi.fn(), onCommentAction: vi.fn(), onViewportCommentsChanged: vi.fn(), onToggleComment: vi.fn(), onLoadMissing: vi.fn(),
    }, scope, "", document.body);

    view.setTranslation(101 as never, "即时译文", "<p>即时译文</p>", "<p>即时译文</p>", false);
    expect(view.surfaceRoot.querySelector<HTMLElement>('.hnr-comment[data-comment-id="101"] .hnr-translated-text')?.innerHTML)
      .toContain("即时译文");
    expect(view.translationRecords().has(101 as never)).toBe(false);

    view.setTranslation(101 as never, "完整译文", "<p>完整译文</p>", "<p>完整译文</p>", true);
    expect(view.translationRecords().get(101 as never)?.text).toBe("完整译文");
    scope.destroy();
  });

  it("accepts settings and exposes fetched models through a real select", async () => {
    document.documentElement.innerHTML = readFileSync(resolve("lite/fixtures/hn-item.html"), "utf8");
    const snapshot = parseHnDocument(document);
    const scope = new LifecycleScope();
    const view = new ReaderView(document, new CommentTree(snapshot.story, snapshot.comments), new CommentProjection(new CommentTree(snapshot.story, snapshot.comments)), true, {
      onClose: vi.fn(), onCommand: vi.fn(), onCommentAction: vi.fn(), onViewportCommentsChanged: vi.fn(), onToggleComment: vi.fn(), onLoadMissing: vi.fn(),
    }, scope, "", document.body);
    const onSave = vi.fn();
    const onThemePreview = vi.fn();
    const onSettingsPreview = vi.fn();
    view.openSettings(DEFAULT_SETTINGS, { onSave, onLoadModels: () => Promise.resolve(["gpt-test"]), onThemePreview, onSettingsPreview, onClearCache: () => Promise.resolve(), onReset: vi.fn() });
    const form = view.surfaceRoot.querySelector<HTMLFormElement>(".hnr-settings");
    expect(form?.checkValidity()).toBe(true);
    expect(view.surfaceRoot.querySelectorAll(".hnr-settings-tab")).toHaveLength(4);
    expect(view.surfaceRoot.querySelectorAll(".hnr-settings-nav-group")).toHaveLength(3);
    expect(view.surfaceRoot.querySelectorAll(".hnr-settings-section")).toHaveLength(4);
    expect(view.surfaceRoot.querySelector(".hnr-settings-tabs .hnr-settings-brand-name")?.textContent).toBe("HACKERNEWSREADER");
    expect(view.surfaceRoot.querySelector('[data-settings-panel="reading"].hnr-settings-tab')?.getAttribute("aria-selected")).toBe("true");
    const translationTheme = view.surfaceRoot.querySelector<HTMLSelectElement>('select[name="translationTheme"]');
    if (!translationTheme) throw new Error("translation theme selector was not rendered");
    expect([...translationTheme.options].map((option) => option.value)).toEqual([
      "quote", "plain", "weakening", "dividing-line", "underline", "highlight", "paper",
    ]);
    expect(translationTheme.value).toBe("paper");
    const translationThemePreview = view.surfaceRoot.querySelector('[aria-label="译文样式效果预览"]');
    const translationThemeField = translationTheme.closest(".hnr-translation-theme-field");
    expect(translationThemePreview?.textContent).toContain("知识会在分享中不断生长。");
    expect(translationThemeField?.lastElementChild).toBe(translationThemePreview);
    expect(translationThemePreview?.previousElementSibling?.contains(translationTheme)).toBe(true);
    translationTheme.value = "highlight";
    translationTheme.dispatchEvent(new Event("change"));
    expect((view.surfaceRoot.host as HTMLElement).dataset.translationTheme).toBe("highlight");
    expect(onSettingsPreview).toHaveBeenLastCalledWith(expect.objectContaining({ translationTheme: "highlight" }));
    view.surfaceRoot.querySelector<HTMLButtonElement>('[data-settings-panel="ai"].hnr-settings-tab')?.click();
    expect(view.surfaceRoot.querySelector('[data-settings-panel="ai"].hnr-settings-section')?.hasAttribute("hidden")).toBe(false);
    view.surfaceRoot.querySelector<HTMLButtonElement>(".hnr-load-models")?.click();
    await Promise.resolve();
    await Promise.resolve();
    const modelSelect = view.surfaceRoot.querySelector<HTMLSelectElement>(".hnr-model-select");
    if (!modelSelect) throw new Error("model select was not rendered");
    expect(modelSelect?.disabled).toBe(false);
    expect([...modelSelect?.options ?? []].map((option) => option.value)).toEqual(["gpt-test"]);
    modelSelect.value = "gpt-test";
    modelSelect.dispatchEvent(new Event("change"));
    expect(view.surfaceRoot.querySelector<HTMLInputElement>('input[name="aiModel"]')?.value).toBe("gpt-test");
    const search = view.surfaceRoot.querySelector<HTMLInputElement>(".hnr-settings-search input");
    if (!search) throw new Error("settings search was not rendered");
    search.value = "字体";
    search.dispatchEvent(new Event("input"));
    expect(view.surfaceRoot.querySelectorAll(".hnr-settings-tab:not([hidden])")).toHaveLength(1);
    expect(view.surfaceRoot.querySelector('[data-settings-panel="font"].hnr-settings-tab')?.getAttribute("aria-selected")).toBe("true");
    view.surfaceRoot.querySelector<HTMLButtonElement>(".hnr-settings-search-clear")?.click();
    expect(view.surfaceRoot.querySelectorAll(".hnr-settings-tab:not([hidden])")).toHaveLength(4);
    const theme = view.surfaceRoot.querySelector<HTMLSelectElement>(".hnr-settings-sidebar-footer select[name='theme']");
    if (!theme) throw new Error("bottom theme selector was not rendered");
    theme.value = "dark";
    theme.dispatchEvent(new Event("change"));
    expect((view.surfaceRoot.host as HTMLElement).dataset.theme).toBe("dark");
    expect(onThemePreview).toHaveBeenLastCalledWith("dark");
    form?.requestSubmit();
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ theme: "dark", translationTheme: "highlight" }));
    scope.destroy();
  });

  it("loads searchable local fonts once for title and body, previews both, and restores them on cancel", async () => {
    document.documentElement.innerHTML = readFileSync(resolve("lite/fixtures/hn-item.html"), "utf8");
    const snapshot = parseHnDocument(document);
    const scope = new LifecycleScope();
    const tree = new CommentTree(snapshot.story, snapshot.comments);
    const view = new ReaderView(document, tree, new CommentProjection(tree), true, {
      onClose: vi.fn(), onCommand: vi.fn(), onCommentAction: vi.fn(), onViewportCommentsChanged: vi.fn(), onToggleComment: vi.fn(), onLoadMissing: vi.fn(),
    }, scope, "", document.body);
    const onSave = vi.fn();
    const queryLocalFonts = vi.fn(() => Promise.resolve([
      "Arial",
      "Microsoft YaHei",
      "Noto Sans CJK SC",
      "Noto Sans CJK SC",
    ]));
    view.applySettings(DEFAULT_SETTINGS);
    view.openSettings(DEFAULT_SETTINGS, {
      onSave,
      onLoadModels: () => Promise.resolve([]),
      onClearCache: () => Promise.resolve(),
      onReset: vi.fn(),
      queryLocalFonts,
    });

    const host = view.surfaceRoot.host as HTMLElement;
    const titleFamily = view.surfaceRoot.querySelector<HTMLInputElement>('input[name="titleFontFamily"]');
    const titleCustom = view.surfaceRoot.querySelector<HTMLInputElement>('input[name="titleCustomFontFamily"]');
    const family = view.surfaceRoot.querySelector<HTMLInputElement>('input[name="fontFamily"]');
    const custom = view.surfaceRoot.querySelector<HTMLInputElement>('input[name="customFontFamily"]');
    const fontRendering = view.surfaceRoot.querySelector<HTMLSelectElement>('select[name="fontRenderingEnabled"]');
    const weight = view.surfaceRoot.querySelector<HTMLSelectElement>('select[name="fontWeight"]');
    const scale = view.surfaceRoot.querySelector<HTMLInputElement>('input[name="fontScale"]');
    const lineHeight = view.surfaceRoot.querySelector<HTMLInputElement>('input[name="lineHeight"]');
    if (!titleFamily || !titleCustom || !family || !custom || !fontRendering || !weight || !scale || !lineHeight) {
      throw new Error("font controls were not rendered");
    }
    expect([...view.surfaceRoot.querySelectorAll(".hnr-font-setting-row strong")].map((element) => element.textContent)).toEqual([
      "字体显示优化",
      "标题字体",
      "正文字体",
      "字重",
      "字号",
      "行高",
    ]);
    expect(scale.step).toBe("0.01");
    expect(host.dataset.fontRendering).toBe("builtin");

    view.surfaceRoot.querySelector<HTMLButtonElement>('[data-settings-panel="font"].hnr-settings-tab')?.click();
    await vi.waitFor(() => {
      expect([...view.surfaceRoot.querySelectorAll(".hnr-local-font-status")]
        .every((status) => status.textContent?.includes("已读取 3 个本机字体"))).toBe(true);
    });
    expect(queryLocalFonts).toHaveBeenCalledOnce();

    const pickers = [...view.surfaceRoot.querySelectorAll<HTMLElement>(".hnr-local-font-picker")];
    const titlePicker = pickers[0];
    const bodyPicker = pickers[1];
    if (!titlePicker || !bodyPicker) throw new Error("title and body font pickers were not rendered");
    titlePicker.querySelector<HTMLButtonElement>(".hnr-local-font-trigger")?.click();
    const titleSearch = titlePicker.querySelector<HTMLInputElement>(".hnr-local-font-search input");
    if (!titleSearch) throw new Error("title font search was not rendered");
    titleSearch.value = "微软";
    titleSearch.dispatchEvent(new Event("input"));
    const titleOption = titlePicker.querySelector<HTMLButtonElement>('.hnr-local-font-option[data-font-name="Microsoft YaHei"]');
    expect(titleOption?.textContent).toContain("微软雅黑（Microsoft YaHei）");
    expect(titleOption?.querySelector<HTMLElement>(".hnr-local-font-option-sample")?.style.fontFamily).toContain("Microsoft YaHei");
    titleOption?.click();

    bodyPicker.querySelector<HTMLButtonElement>(".hnr-local-font-trigger")?.click();
    const bodySearch = bodyPicker.querySelector<HTMLInputElement>(".hnr-local-font-search input");
    if (!bodySearch) throw new Error("body font search was not rendered");
    bodySearch.value = "思源";
    bodySearch.dispatchEvent(new Event("input"));
    bodyPicker.querySelector<HTMLButtonElement>('.hnr-local-font-option[data-font-name="Noto Sans CJK SC"]')?.click();

    weight.value = "500";
    weight.dispatchEvent(new Event("change"));
    scale.value = "1.2";
    scale.dispatchEvent(new Event("input"));
    lineHeight.value = "1.8";
    lineHeight.dispatchEvent(new Event("input"));
    fontRendering.value = "off";
    fontRendering.dispatchEvent(new Event("change"));

    expect(titleFamily.value).toBe("custom");
    expect(titleCustom.value).toBe("Microsoft YaHei");
    expect(family.value).toBe("custom");
    expect(custom.value).toBe("Noto Sans CJK SC");
    expect(host.style.getPropertyValue("--hnr-title-font-family")).toContain("\"Microsoft YaHei\"");
    expect(host.style.getPropertyValue("--hnr-content-font-family")).toContain("\"Noto Sans CJK SC\"");
    expect(host.style.getPropertyValue("--hnr-content-font-weight")).toBe("500");
    expect(host.style.getPropertyValue("--hnr-font-scale")).toBe("1.2");
    expect(host.style.getPropertyValue("--hnr-line-height")).toBe("1.8");
    expect(host.dataset.fontRendering).toBe("off");
    expect(view.surfaceRoot.querySelectorAll(".hnr-font-range-value")[0]?.textContent).toBe("120%");

    view.surfaceRoot.querySelector<HTMLButtonElement>(".hnr-settings-cancel")?.click();
    expect(host.style.getPropertyValue("--hnr-title-font-family")).toContain("system-ui");
    expect(host.style.getPropertyValue("--hnr-content-font-family")).toContain("system-ui");
    expect(host.style.getPropertyValue("--hnr-content-font-weight")).toBe("500");
    expect(host.style.getPropertyValue("--hnr-font-scale")).toBe("0.92");
    expect(host.style.getPropertyValue("--hnr-line-height")).toBe("1.52");
    expect(host.dataset.fontRendering).toBe("builtin");
    expect(onSave).not.toHaveBeenCalled();
    scope.destroy();
  });

  it("closes settings with Escape or a backdrop click without treating panel clicks as dismissal", () => {
    document.documentElement.innerHTML = readFileSync(resolve("lite/fixtures/hn-item.html"), "utf8");
    const snapshot = parseHnDocument(document);
    const scope = new LifecycleScope();
    const tree = new CommentTree(snapshot.story, snapshot.comments);
    const onClose = vi.fn();
    const view = new ReaderView(document, tree, new CommentProjection(tree), true, {
      onClose, onCommand: vi.fn(), onCommentAction: vi.fn(), onViewportCommentsChanged: vi.fn(), onToggleComment: vi.fn(), onLoadMissing: vi.fn(),
    }, scope, "", document.body);
    const callbacks = { onSave: vi.fn(), onLoadModels: () => Promise.resolve([]), onClearCache: () => Promise.resolve(), onReset: vi.fn() };

    view.openSettings(DEFAULT_SETTINGS, callbacks);
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(view.surfaceRoot.querySelector(".hnr-settings-backdrop")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    view.openSettings(DEFAULT_SETTINGS, callbacks);
    view.surfaceRoot.querySelector<HTMLElement>(".hnr-settings")?.click();
    expect(view.surfaceRoot.querySelector(".hnr-settings-backdrop")).not.toBeNull();
    view.surfaceRoot.querySelector<HTMLElement>(".hnr-settings-backdrop")?.click();
    expect(view.surfaceRoot.querySelector(".hnr-settings-backdrop")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    scope.destroy();
  });
});
