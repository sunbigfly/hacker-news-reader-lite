// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { indexedDB } from "fake-indexeddb";
import { ReaderController } from "../src/app/reader-controller";
import { MemoryCacheStore } from "../src/cache/cache-store";
import { HnApiAdapter, type HnItem } from "../src/hn-api/hn-api-adapter";
import { HnRealtimeAdapter } from "../src/hn-api/hn-realtime-adapter";
import { HnPageFetchAdapter } from "../src/host/hn-page-fetch-adapter";
import { LifecycleScope } from "../src/kernel/lifecycle";
import { RequestScheduler } from "../src/network/request-scheduler";
import { normalizeReaderTopicState, ReaderWorkspaceStateStore } from "../src/settings/reader-workspace-state-store";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/settings/settings-store";
import { ReaderView } from "../src/shell/reader-view";
import { VirtualCommentList } from "../src/stream/virtual-comment-list";
import { CommentProjection } from "../src/thread/comment-projection";
import { CommentTree } from "../src/thread/comment-tree";
import { ThreadSnapshotRepository } from "../src/thread/thread-snapshot-repository";
import type { Comment, Story } from "../src/thread/model";

const story: Story = { id: 1 as never, title: "Replies", url: null, author: "author", score: 1, html: "", childIds: [2 as never], descendants: 50, observedAt: 1 };
const comment = (id: number, parentId = 2, childIds: number[] = []): Comment => ({
  id: id as never, storyId: 1 as never, parentId: parentId as never, childIds: childIds as never,
  rank: id, author: `user${id}`, createdAt: null, html: `<p>Comment ${id}</p>`, text: `Comment ${id}`,
  deleted: false, dead: false, source: "dom", observedAt: 1,
});
function wideTree(count: number): CommentTree {
  const children = Array.from({ length: count }, (_, index) => 3 + index);
  return new CommentTree(story, [comment(2, 1, children), ...children.map((id) => comment(id))]);
}
const ids = (projection: CommentProjection): number[] => projection.entries().filter((entry) => entry.kind === "comment").map((entry) => entry.id);
function element(root: ParentNode, selector: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`Missing test element: ${selector}`);
  return found;
}
const scopes: LifecycleScope[] = [];
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("smart reply projection", () => {
  it("keeps ten replies visible and folds eleven without collapsing the parent body", () => {
    expect(ids(new CommentProjection(wideTree(10)))).toHaveLength(11);
    const projection = new CommentProjection(wideTree(11));
    expect(ids(projection)).toEqual([2]);
    expect(projection.entries()[0]).toMatchObject({ collapsed: false, repliesExpanded: false });
    expect(projection.entries()[1]).toMatchObject({ kind: "replies", remainingCount: 11, countExact: true });
  });

  it("shows two levels and opens a deeper branch independently", () => {
    const tree = new CommentTree(story, [comment(2, 1, [3, 6]), comment(3, 2, [4]), comment(4, 3, [5]), comment(5, 4), comment(6)]);
    const projection = new CommentProjection(tree);
    expect(ids(projection)).toEqual([2, 3, 6]);
    projection.expandReplies(3 as never);
    expect(ids(projection)).toEqual([2, 3, 4, 6]);
    expect(projection.entries().find((entry) => entry.kind === "replies")).toMatchObject({ parentId: 4, remainingCount: 1 });
  });

  it("pages direct siblings in HN order and restores explicit choices across tree updates", () => {
    const tree = wideTree(45);
    const projection = new CommentProjection(tree);
    projection.expandReplies(2 as never);
    expect(ids(projection)).toEqual([2, ...Array.from({ length: 20 }, (_, index) => index + 3)]);
    expect(projection.entries().at(-1)).toMatchObject({ kind: "replies", remainingCount: 25, shownCount: 20 });
    projection.expandReplies(2 as never);
    expect(ids(projection)).toHaveLength(41);
    tree.ingest([comment(48)]);
    const restored = new CommentProjection(tree);
    restored.restoreReplyWindows(projection.replyWindows());
    expect(ids(restored)).toHaveLength(41);
    restored.collapseReplies(2 as never);
    expect(ids(restored)).toEqual([2]);
    restored.configure({ ...DEFAULT_SETTINGS, commentDisplayMode: "expanded" });
    expect(ids(restored)).toEqual([2]);
    expect(new CommentProjection(tree, { ...DEFAULT_SETTINGS, commentDisplayMode: "expanded" }).entries()).toHaveLength(47);
  });

  it("reveals a permalink beyond the first page without opening unrelated subbranches", () => {
    const tree = wideTree(60);
    tree.ingest([comment(3, 2, [90]), comment(90, 3)]);
    const projection = new CommentProjection(tree);
    projection.reveal(55 as never);
    expect(ids(projection)).toContain(55);
    expect(ids(projection)).not.toContain(90);
    expect(projection.replyWindows()).toContainEqual({ id: 2, count: 60 });
  });

  it("reports incomplete counts as a lower bound and only exposes the selected missing page", () => {
    const tree = new CommentTree(story, [comment(2, 1, Array.from({ length: 30 }, (_, index) => index + 3))]);
    const projection = new CommentProjection(tree);
    expect(projection.entries()[1]).toMatchObject({ kind: "replies", countExact: false, remainingCount: 30 });
    projection.expandReplies(2 as never);
    expect(projection.entries().filter((entry) => entry.kind === "missing")).toHaveLength(20);
    expect(tree.size).toBe(1);
  });

  it("keeps roots-only and whole-branch collapse separate from reply visibility", () => {
    const projection = new CommentProjection(wideTree(3), { ...DEFAULT_SETTINGS, commentDisplayMode: "roots" });
    expect(ids(projection)).toEqual([2]);
    projection.expandReplies(2 as never);
    expect(ids(projection)).toEqual([2, 3, 4, 5]);
    projection.toggle(2 as never);
    expect(projection.entries()).toHaveLength(1);
    projection.toggle(2 as never);
    expect(ids(projection)).toEqual([2, 3, 4, 5]);
  });

  it("validates settings and migrates topic records without losing manual windows", () => {
    expect(normalizeSettings({})).toMatchObject({ commentDisplayMode: "smart", replyCollapseThreshold: 10, commentExpandDepth: 2, replyPageSize: 20 });
    expect(normalizeSettings({ commentDisplayMode: "invalid", replyCollapseThreshold: -1, commentExpandDepth: 200, replyPageSize: 0 })).toMatchObject({ commentDisplayMode: "smart", replyCollapseThreshold: 1, commentExpandDepth: 10, replyPageSize: 5 });
    const state = normalizeReaderTopicState({ replyWindows: [{ id: 2, count: 40 }, { id: 3, count: 0 }, { id: -1, count: 20 }, { id: 4, count: -1 }, null] });
    expect(state?.replyWindows).toEqual([{ id: 2, count: 40 }, { id: 3, count: 0 }]);
    expect(normalizeReaderTopicState({ storyTitle: "Old", collapsedCommentIds: [2] })?.collapsedCommentIds).toEqual([2]);
  });

  it("preserves the first hidden reply as its marker becomes a comment after earlier rows are inserted", () => {
    const projection = new CommentProjection(wideTree(45));
    const container = document.createElement("div");
    const scope = new LifecycleScope();
    scopes.push(scope);
    const list = new VirtualCommentList(container, () => document.createElement("article"), scope);
    list.setEntries(projection.entries());
    container.scrollTop = 112 + 8;
    projection.expandReplies(2 as never);
    list.setEntries([{ kind: "comment", id: 99 as never, depth: 0, hasChildren: false, collapsed: false }, ...projection.entries()]);
    expect(list.capturePosition()).toEqual({ id: 3, offset: 8 });
    expect(container.scrollTop).toBe(224 + 8);
    expect(list.mountedCount).toBeLessThanOrEqual(120);
  });
});

describe("smart reply controls", () => {
  function render(tree = wideTree(45)): { view: ReaderView; projection: CommentProjection } {
    const scope = new LifecycleScope();
    scopes.push(scope);
    const projection = new CommentProjection(tree);
    const view = new ReaderView(document, tree, projection, true, {
      onClose: vi.fn(), onCommand: vi.fn(), onCommentAction: vi.fn(), onViewportCommentsChanged: vi.fn(), onToggleComment: vi.fn(), onLoadMissing: vi.fn(),
      onReplyAction: (id, action) => {
        if (action === "expand") projection.expandReplies(id);
        else projection.collapseReplies(id);
        view.update(tree, projection, true);
      },
    }, scope, "", document.body);
    return { view, projection };
  }

  it.each([false, true])("pins expanded replies to the clicked control through later layout updates (missing: %s)", async (missing) => {
    const tree = missing
      ? new CommentTree(story, [comment(2, 1, Array.from({ length: 30 }, (_, index) => index + 3))])
      : wideTree(45);
    const { view, projection } = render(tree);
    const viewport = element(view.surfaceRoot, ".hnr-comments");
    viewport.scrollTop = 200;
    let layoutShift = 0;
    const rect = (top: number, height: number): DOMRect => ({
      x: 0, y: top, top, right: 800, bottom: top + height, left: 0,
      width: 800, height, toJSON: () => ({}),
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === viewport) return rect(100, 500);
      if (this.dataset.action === "expand-replies") return rect(360, 40);
      if (this.dataset.commentId === "3") return rect(660 + layoutShift - viewport.scrollTop, 112);
      return rect(0, 0);
    });
    element(view.surfaceRoot, '[data-action="expand-replies"]').click();
    const firstReply = () => element(view.surfaceRoot, ':is(.hnr-comment, .hnr-missing)[data-comment-id="3"]');
    expect(firstReply().getBoundingClientRect().top).toBe(360);
    if (missing) tree.ingest(Array.from({ length: 30 }, (_, index) => comment(index + 3)));
    layoutShift = 120;
    view.update(tree, projection, true);
    await vi.waitFor(() => expect(firstReply().getBoundingClientRect().top).toBe(360));
    expect(firstReply().classList.contains("hnr-comment")).toBe(true);
    viewport.dispatchEvent(new WheelEvent("wheel"));
    layoutShift = 240;
    const scrollTop = viewport.scrollTop;
    view.update(tree, projection, true);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(viewport.scrollTop).toBe(scrollTop);
  });

  it("retains parent text, mounts replies only after activation, and can hide replies alone", () => {
    const { view, projection } = render();
    const root = view.surfaceRoot;
    expect(root.querySelector<HTMLElement>(".hnr-comment-body")?.hidden).toBe(false);
    expect(root.querySelector(".hnr-comment-body")?.textContent).toContain("Comment 2");
    expect(root.querySelectorAll(".hnr-comment")).toHaveLength(1);
    root.querySelector<HTMLButtonElement>('[data-action="expand-replies"]')?.click();
    expect(ids(projection)).toHaveLength(21);
    expect(root.querySelectorAll(".hnr-comment").length).toBeGreaterThan(1);
    root.querySelector<HTMLButtonElement>('[data-action="collapse-replies"]')?.click();
    expect(root.querySelectorAll(".hnr-comment")).toHaveLength(1);
    expect(root.querySelector<HTMLElement>(".hnr-comment-body")?.hidden).toBe(false);
    expect(root.querySelector(".hnr-replies-button")?.textContent).toBe("展开 45 条回复");
  });

  it("keeps the second-level expansion point after collapsing and reopening the same branch", async () => {
    const children = Array.from({ length: 21 }, (_, index) => index + 4);
    const tree = new CommentTree(story, [comment(2, 1, [3]), comment(3, 2, children), ...children.map((id) => comment(id, 3))]);
    const { view, projection } = render(tree);
    const viewport = element(view.surfaceRoot, ".hnr-comments");
    let layoutShift = 0;
    const rect = (top: number, height: number): DOMRect => ({
      x: 0, y: top, top, right: 800, bottom: top + height, left: 0,
      width: 800, height, toJSON: () => ({}),
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === viewport) return rect(100, 500);
      if (this.dataset.action === "expand-replies") return rect((this.dataset.commentId === "2" ? 660 : 900 + layoutShift) - viewport.scrollTop, 40);
      if (this.dataset.commentId === "3") return rect(660 - viewport.scrollTop, 112);
      if (this.dataset.commentId === "4") return rect(900 + layoutShift - viewport.scrollTop, 112);
      return rect(0, 0);
    });
    viewport.scrollTop = 300;
    element(view.surfaceRoot, '[data-action="expand-replies"][data-comment-id="2"]').click();
    for (let cycle = 0; cycle < 3; cycle += 1) {
      viewport.scrollTop = 900 + layoutShift - 420;
      element(view.surfaceRoot, '[data-action="expand-replies"][data-comment-id="3"]').click();
      const childTop = () => element(view.surfaceRoot, '.hnr-comment[data-comment-id="4"]').getBoundingClientRect().top;
      expect(childTop()).toBe(420);
      layoutShift += 170;
      view.update(tree, projection, true);
      await vi.waitFor(() => expect(childTop()).toBe(420));
      viewport.dispatchEvent(new WheelEvent("wheel"));
      viewport.scrollTop += 90;
      element(view.surfaceRoot, '[data-action="collapse-replies"][data-comment-id="3"]').click();
      expect(view.surfaceRoot.querySelector('.hnr-comment[data-comment-id="4"]')).toBeNull();
      expect(element(view.surfaceRoot, '[data-action="expand-replies"][data-comment-id="3"]').getBoundingClientRect().top).toBe(420);
    }
    element(view.surfaceRoot, '[data-action="collapse-replies"][data-comment-id="2"]').click();
    expect(element(view.surfaceRoot, '[data-action="expand-replies"][data-comment-id="2"]').getBoundingClientRect().top).toBe(360);
  });

  it("saves the selected mode and custom limits while disabled smart fields retain their values", () => {
    const { view } = render();
    const onSave = vi.fn();
    view.openSettings(DEFAULT_SETTINGS, { onSave, onLoadModels: () => Promise.resolve([]), onClearCache: () => Promise.resolve(), onReset: vi.fn() });
    const root = view.surfaceRoot;
    const threshold = element(root, '[name="replyCollapseThreshold"]') as HTMLInputElement;
    threshold.value = "15";
    const mode = element(root, '[name="commentDisplayMode"]') as HTMLSelectElement;
    mode.value = "roots";
    mode.dispatchEvent(new Event("change", { bubbles: true }));
    expect(threshold.disabled).toBe(true);
    root.querySelector<HTMLFormElement>(".hnr-settings")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ commentDisplayMode: "roots", replyCollapseThreshold: 15, commentExpandDepth: 2, replyPageSize: 20 }));
  });
});

it("loads only the opened missing page, reuses pending and cached items, and cancels on close", async () => {
  document.documentElement.innerHTML = '<head><base href="https://news.ycombinator.com/news"></head><body><table></table></body>';
  vi.stubGlobal("indexedDB", indexedDB);
  const stored = new Map<string, unknown>();
  vi.stubGlobal("GM_getValue", (key: string, fallback: unknown) => stored.get(key) ?? fallback);
  vi.stubGlobal("GM_setValue", (key: string, value: unknown) => { stored.set(key, value); });
  const tree = new CommentTree(story, [comment(2, 1, Array.from({ length: 30 }, (_, index) => index + 3))]);
  const snapshots = new ThreadSnapshotRepository(new MemoryCacheStore<unknown>());
  await snapshots.set(tree.snapshot(false));
  const pending = new Map<number, (item: HnItem) => void>();
  const getItem = vi.fn((id: number, signal: AbortSignal) => {
    if (signal.aborted) return Promise.reject(new Error("Reader closed"));
    return new Promise<HnItem>((resolve) => { pending.set(id, resolve); });
  });
  const converter = new HnApiAdapter({ request: vi.fn(() => Promise.reject(new Error("unexpected request"))) });
  const sessionApi = {
    getItem, loadCommentSubtrees: vi.fn(), loadThread: vi.fn(),
    toStory: converter.toStory.bind(converter), toComment: converter.toComment.bind(converter),
  };
  const scope = new LifecycleScope();
  scopes.push(scope);
  const controller = new ReaderController(document, scope, "", new ReaderWorkspaceStateStore(), {
    threadSnapshots: snapshots,
    pageFetcher: new HnPageFetchAdapter(document, new RequestScheduler(1), () => Promise.resolve(new Response("", { status: 503 }))),
    yieldToFirstPaint: () => Promise.resolve(),
    realtime: new HnRealtimeAdapter(() => Object.assign(new EventTarget(), { close: vi.fn() })),
    sessionApi,
  });
  await controller.open(1 as never);
  const root = element(document, "#hn-reader-root").shadowRoot;
  if (!root) throw new Error("Missing Reader shadow root");
  expect(getItem).not.toHaveBeenCalled();
  element(root, '[data-action="expand-replies"]').click();
  expect(getItem.mock.calls.map(([id]) => id)).toEqual(Array.from({ length: 20 }, (_, index) => index + 3));
  element(root, '[data-action="load-missing"]').click();
  expect(getItem).toHaveBeenCalledTimes(20);
  const resolvePending = (): void => {
    for (const [id, resolve] of pending) resolve({ id, parent: 2, type: "comment", text: `Reply ${id}`, by: "reply", kids: [], time: null, deleted: false, dead: false, url: null, title: "", score: null, descendants: null });
    pending.clear();
  };
  resolvePending();
  await vi.waitFor(() => expect(root.querySelector(".hnr-coverage")?.textContent).toContain("21 条评论"));
  element(root, '[data-action="collapse-replies"]').click();
  element(root, '[data-action="expand-replies"]').click();
  expect(getItem).toHaveBeenCalledTimes(20);
  expect(sessionApi.loadThread).not.toHaveBeenCalled();
  expect(sessionApi.loadCommentSubtrees).not.toHaveBeenCalled();
  const viewport = element(root, ".hnr-comments");
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  viewport.dispatchEvent(new Event("wheel"));
  viewport.scrollTop = 2_000;
  viewport.dispatchEvent(new Event("scroll"));
  await vi.waitFor(() => expect(root.querySelector('[data-action="expand-replies"]')).not.toBeNull());
  element(root, '[data-action="expand-replies"]').click();
  expect(getItem).toHaveBeenCalledTimes(30);
  scope.destroy();
  expect(getItem.mock.calls.every(([, signal]) => signal.aborted)).toBe(true);
  resolvePending();
  await Promise.resolve();
  expect(document.querySelector("#hn-reader-root")).toBeNull();
  expect((stored.get("hn-reader:topic-state:v1:1") as { replyWindows: unknown }).replyWindows).toContainEqual({ id: 2, count: 40 });
});
