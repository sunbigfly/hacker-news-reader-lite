// @vitest-environment jsdom

import { indexedDB } from "fake-indexeddb";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReaderController } from "../src/app/reader-controller";
import { MemoryCacheStore } from "../src/cache/cache-store";
import { HnApiAdapter, type HnItem } from "../src/hn-api/hn-api-adapter";
import { HnRealtimeAdapter } from "../src/hn-api/hn-realtime-adapter";
import { parseHnDocument } from "../src/host/hn-dom-adapter";
import { HnPageFetchAdapter } from "../src/host/hn-page-fetch-adapter";
import { LifecycleScope } from "../src/kernel/lifecycle";
import { RequestScheduler } from "../src/network/request-scheduler";
import { ReaderWorkspaceStateStore } from "../src/settings/reader-workspace-state-store";
import { DEFAULT_SETTINGS } from "../src/settings/settings-store";
import { ThreadSnapshotRepository } from "../src/thread/thread-snapshot-repository";
import type { Comment } from "../src/thread/model";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function translationThreadHtml(commentCount: number): string {
  const comments = Array.from({ length: commentCount }, (_, index) => {
    const id = 101 + index;
    return `<tr class="athing comtr" id="${id}"><td class="ind"><img width="0"></td><td><span class="comhead"><a class="hnuser">user${index + 1}</a></span><div class="comment"><span class="commtext c00">Comment ${index + 1} explains a detailed software engineering practice for readers who need a complete translation.</span></div></td></tr>`;
  }).join("");
  return `<!doctype html><html><head><base href="https://news.ycombinator.com/"></head><body><table class="fatitem"><tr class="athing" id="100"><td class="title"><span class="titleline"><a href="https://example.com/article">Example story</a></span></td></tr><tr><td class="subtext"><span class="score">42 points</span> by <a class="hnuser">alice</a></td></tr></table><table class="comment-tree">${comments}</table></body></html>`;
}

function threadHtmlAroundReaderOpen(openedAt: number): string {
  const comment = (id: number, author: string, createdAt: number, text: string) => `<tr class="athing comtr" id="${id}"><td class="ind"><img width="0"></td><td><span class="comhead"><a class="hnuser">${author}</a> <span class="age" title="${new Date(createdAt).toISOString()}">now</span></span><div class="comment"><span class="commtext c00">${text}</span></div></td></tr>`;
  return `<!doctype html><html><head><base href="https://news.ycombinator.com/"></head><body><table class="fatitem"><tr class="athing" id="100"><td class="title"><span class="titleline"><a href="https://example.com/article">Example story</a></span></td></tr><tr><td class="subtext"><span class="score">42 points</span> by <a class="hnuser">alice</a></td></tr></table><table class="comment-tree">${comment(101, "before", openedAt - 60_000, "Existing before Reader opened.")}${comment(102, "after", openedAt + 60_000, "Published after Reader opened.")}</table></body></html>`;
}

function deepTranslationThreadHtml(commentCount: number): string {
  const comments = Array.from({ length: commentCount }, (_, index) => {
    const id = 101 + index;
    const depth = index % 12;
    const body = id === 322
      ? Array.from({ length: 18 }, (_, paragraph) => `Long target paragraph ${paragraph + 1} must keep the comment header visible after location.`).join("<p>")
      : `Deep comment ${index + 1} remains addressable after the virtual reader replaces its optimistic first screen.`;
    return `<tr class="athing comtr" id="${id}"><td class="ind"><img width="${depth * 40}"></td><td><span class="comhead"><a class="hnuser">user${index + 1}</a></span><div class="comment"><span class="commtext c00">${body}</span></div></td></tr>`;
  }).join("");
  return `<!doctype html><html><head><base href="https://news.ycombinator.com/"></head><body><table class="fatitem"><tr class="athing" id="100"><td class="title"><span class="titleline"><a href="https://example.com/article">Example story</a></span></td></tr><tr><td class="subtext"><span class="score">42 points</span> by <a class="hnuser">alice</a></td></tr></table><table class="comment-tree">${comments}</table></body></html>`;
}

function fetchedThreadHtml(storyId: number): string {
  return `<!doctype html><html><head></head><body>
    <table class="fatitem"><tbody>
      <tr class="athing" id="${storyId}"><td class="title"><span class="titleline"><a href="https://example.com/${storyId}">Story ${storyId}</a></span></td></tr>
      <tr><td class="subtext"><span class="score">1 point</span> by <a class="hnuser">alice</a></td></tr>
    </tbody></table>
    <table class="comment-tree"><tbody>
      <tr class="athing comtr" id="${storyId + 1}"><td class="ind"><img width="0"></td><td><span class="comhead"><a class="hnuser">bob</a></span><div class="comment"><span class="commtext c00">Comment for story ${storyId}</span></div></td></tr>
    </tbody></table>
  </body></html>`;
}

class FakeHnRealtimeSource extends EventTarget {
  closed = false;

  close(): void {
    this.closed = true;
  }

  emitItems(ids: readonly number[]): void {
    this.dispatchEvent(new MessageEvent("put", {
      data: JSON.stringify({ path: "/", data: { items: ids } }),
    }));
  }
}

describe("ReaderController workspace continuity", () => {
  it("closes the mobile Reader on browser back and retains the host document", async () => {
    history.replaceState({ host: true }, "", "/news?p=2");
    document.documentElement.innerHTML = "<head></head><body><center><table id='hnmain'></table></center></body>";
    vi.stubGlobal("indexedDB", indexedDB);
    vi.stubGlobal("GM_getValue", (_key: string, fallback: unknown) => fallback);
    vi.stubGlobal("GM_setValue", vi.fn());
    vi.stubGlobal("matchMedia", () => Object.assign(new EventTarget(), { matches: true }));
    vi.stubGlobal("scrollY", 320);
    const scrollTo = vi.fn();
    vi.stubGlobal("scrollTo", scrollTo);
    const host = document.querySelector("#hnmain");
    const scope = new LifecycleScope();
    const controller = new ReaderController(document, scope, "", new ReaderWorkspaceStateStore(), {
      threadSnapshots: new ThreadSnapshotRepository(new MemoryCacheStore<unknown>()),
      pageFetcher: new HnPageFetchAdapter(document, new RequestScheduler(1), () => Promise.resolve(new Response(fetchedThreadHtml(100)))),
      yieldToFirstPaint: () => Promise.resolve(),
      realtime: new HnRealtimeAdapter(() => new FakeHnRealtimeSource()),
    });
    try {
      await controller.open(100 as never);
      expect(document.querySelector("#hn-reader-root")).not.toBeNull();
      history.back();
      await vi.waitFor(() => expect(document.querySelector("#hn-reader-workspace")).toBeNull());
      expect(document.querySelector("#hnmain")).toBe(host);
      expect(location.pathname + location.search).toBe("/news?p=2");
      expect(history.state).toEqual({ host: true });
      expect(scrollTo).toHaveBeenCalledWith({ left: 0, top: 320, behavior: "instant" });
    } finally {
      scope.destroy();
    }
  });

  it("jumps a long deep comment header to the viewport start after the complete tree replaces the first screen", async () => {
    document.documentElement.innerHTML = `<head><base href="https://news.ycombinator.com/newcomments"></head><body><table></table></body>`;
    vi.stubGlobal("indexedDB", indexedDB);
    vi.stubGlobal("GM_getValue", (key: string, fallback: unknown) => key === "hn-reader:settings:v1"
      ? { ...DEFAULT_SETTINGS, commentDisplayMode: "expanded" } : fallback);
    vi.stubGlobal("GM_setValue", vi.fn());
    const fetchPage = vi.fn(() => Promise.resolve(new Response(deepTranslationThreadHtml(330), { status: 200 })));
    const getBoundingClientRect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function getRect(this: HTMLElement) {
      const top = this.classList.contains("hnr-comments") ? 100 : this.dataset.commentId === "322" ? 460 : 0;
      return {
        x: 0,
        y: top,
        top,
        right: 800,
        bottom: top + 100,
        left: 0,
        width: 800,
        height: 100,
        toJSON: () => ({}),
      };
    });
    const scope = new LifecycleScope();
    const controller = new ReaderController(document, scope, "", new ReaderWorkspaceStateStore(), {
      pageFetcher: new HnPageFetchAdapter(document, new RequestScheduler(1), fetchPage),
      threadSnapshots: new ThreadSnapshotRepository(new MemoryCacheStore<unknown>()),
      yieldToFirstPaint: () => Promise.resolve(),
    });

    try {
      await controller.open(100 as never, 322 as never);
      await Promise.resolve();

      const shadow = document.querySelector<HTMLElement>("#hn-reader-root")?.shadowRoot;
      const viewport = shadow?.querySelector<HTMLElement>(".hnr-comments");
      const target = shadow?.querySelector<HTMLElement>('[data-comment-id="322"]');
      expect(viewport?.scrollTop).toBeGreaterThan(0);
      expect(shadow?.activeElement).toBe(target);
      expect(target?.dataset.locateFlash).toBe("true");
      expect(viewport?.scrollTop).toBeGreaterThan(24_752);
    } finally {
      scope.destroy();
      getBoundingClientRect.mockRestore();
    }
  });

  it("resolves an unknown comment item before opening and locating it in Reader", async () => {
    document.documentElement.innerHTML = `<head><base href="https://news.ycombinator.com/news"></head><body><table></table></body>`;
    vi.stubGlobal("indexedDB", indexedDB);
    vi.stubGlobal("GM_getValue", (_key: string, fallback: unknown) => fallback);
    vi.stubGlobal("GM_setValue", vi.fn());
    const fetchPage = vi.fn(() => Promise.resolve(new Response(translationThreadHtml(80), { status: 200 })));
    const itemResolver = {
      resolveReaderTarget: vi.fn(() => Promise.resolve({
        storyId: 100 as never,
        commentId: 170 as never,
      })),
    };
    const scope = new LifecycleScope();
    const controller = new ReaderController(document, scope, "", new ReaderWorkspaceStateStore(), {
      pageFetcher: new HnPageFetchAdapter(document, new RequestScheduler(1), fetchPage),
      itemResolver,
      threadSnapshots: new ThreadSnapshotRepository(new MemoryCacheStore<unknown>()),
      yieldToFirstPaint: () => Promise.resolve(),
    });

    await controller.openItem(170);

    expect(itemResolver.resolveReaderTarget).toHaveBeenCalledWith(170, expect.any(AbortSignal));
    const shadow = document.querySelector<HTMLElement>("#hn-reader-root")?.shadowRoot;
    const target = shadow?.querySelector<HTMLElement>('[data-comment-id="170"]');
    expect(shadow?.activeElement).toBe(target);
    expect(target?.dataset.locateFlash).toBe("true");
    scope.destroy();
  });

  it("supplements a carried comment path when the current story snapshot does not contain the target", async () => {
    document.documentElement.innerHTML = `<head><base href="https://news.ycombinator.com/newcomments"></head><body><table></table></body>`;
    vi.stubGlobal("indexedDB", indexedDB);
    vi.stubGlobal("GM_getValue", (_key: string, fallback: unknown) => fallback);
    vi.stubGlobal("GM_setValue", vi.fn());
    const fetchPage = vi.fn(() => Promise.resolve(new Response(translationThreadHtml(80), { status: 200 })));
    const itemResolver = {
      resolveReaderTarget: vi.fn(),
      loadCommentPath: vi.fn(() => Promise.resolve([{
        id: 190 as never,
        storyId: 100 as never,
        parentId: 180 as never,
        childIds: Object.freeze([]),
        rank: 0,
        author: "late-commenter",
        createdAt: null,
        html: "Late comment",
        text: "Late comment",
        deleted: false,
        dead: false,
        source: "api" as const,
        observedAt: Date.now(),
      }])),
    };
    const scope = new LifecycleScope();
    const controller = new ReaderController(document, scope, "", new ReaderWorkspaceStateStore(), {
      pageFetcher: new HnPageFetchAdapter(document, new RequestScheduler(1), fetchPage),
      itemResolver,
      threadSnapshots: new ThreadSnapshotRepository(new MemoryCacheStore<unknown>()),
      yieldToFirstPaint: () => Promise.resolve(),
    });

    await controller.open(100 as never, 190 as never);
    await Promise.resolve();

    expect(itemResolver.loadCommentPath).toHaveBeenCalledWith(190, 100, document, expect.any(AbortSignal));
    const shadow = document.querySelector<HTMLElement>("#hn-reader-root")?.shadowRoot;
    const target = shadow?.querySelector<HTMLElement>('[data-comment-id="190"]');
    expect(target?.querySelector(".hnr-author")?.textContent).toBe("late-commenter");
    expect(shadow?.activeElement).toBe(target);
    expect(target?.dataset.locateFlash).toBe("true");
    expect(shadow?.querySelector<HTMLElement>(".hnr-locator-notice")?.textContent).toContain("已定位评论 #190");
    expect(shadow?.querySelector<HTMLElement>(".hnr-locator-notice")?.dataset.tone).toBe("success");
    scope.destroy();
  });

  it("retries a temporarily unavailable carried comment path before locating it", async () => {
    document.documentElement.innerHTML = `<head><base href="https://news.ycombinator.com/newcomments"></head><body><table></table></body>`;
    vi.stubGlobal("indexedDB", indexedDB);
    vi.stubGlobal("GM_getValue", (_key: string, fallback: unknown) => fallback);
    vi.stubGlobal("GM_setValue", vi.fn());
    const target = {
      id: 190 as never,
      storyId: 100 as never,
      parentId: 180 as never,
      childIds: Object.freeze([]),
      rank: 0,
      author: "eventual-commenter",
      createdAt: null,
      html: "Eventually available comment",
      text: "Eventually available comment",
      deleted: false,
      dead: false,
      source: "api" as const,
      observedAt: Date.now(),
    };
    const itemResolver = {
      resolveReaderTarget: vi.fn(),
      loadCommentPath: vi.fn()
        .mockRejectedValueOnce(new Error("HN item response was empty"))
        .mockResolvedValueOnce([target]),
    };
    const waitForCommentPathRetry = vi.fn(() => Promise.resolve());
    const scope = new LifecycleScope();
    const controller = new ReaderController(document, scope, "", new ReaderWorkspaceStateStore(), {
      pageFetcher: new HnPageFetchAdapter(
        document,
        new RequestScheduler(1),
        () => Promise.resolve(new Response(translationThreadHtml(80), { status: 200 })),
      ),
      itemResolver,
      threadSnapshots: new ThreadSnapshotRepository(new MemoryCacheStore<unknown>()),
      yieldToFirstPaint: () => Promise.resolve(),
      waitForCommentPathRetry,
    });

    await controller.open(100 as never, 190 as never);
    await Promise.resolve();

    expect(itemResolver.loadCommentPath).toHaveBeenCalledTimes(2);
    expect(waitForCommentPathRetry).toHaveBeenCalledOnce();
    const shadow = document.querySelector<HTMLElement>("#hn-reader-root")?.shadowRoot;
    const located = shadow?.querySelector<HTMLElement>('[data-comment-id="190"]');
    expect(located?.querySelector(".hnr-author")?.textContent).toBe("eventual-commenter");
    expect(located?.dataset.locateFlash).toBe("true");
    scope.destroy();
  });

  it("reuses the workspace when switching host cards without restoring the old host scroll", async () => {
    document.documentElement.innerHTML = `<head><base href="https://news.ycombinator.com/news"></head><body>
      <center><table id="hnmain"><tbody>
        <tr><td data-hnr-topbar>Hacker News</td></tr>
        <tr><td><table class="itemlist"><tbody>
          <tr class="athing" id="100"><td class="title"><span class="titleline"><a id="story-100" href="https://example.com/100">Story 100</a></span></td></tr>
          <tr><td class="subtext">1 comment</td></tr>
          <tr class="athing" id="200"><td class="title"><span class="titleline"><a id="story-200" href="https://example.com/200">Story 200</a></span></td></tr>
          <tr><td class="subtext">1 comment</td></tr>
        </tbody></table></td></tr>
      </tbody></table></center>
    </body>`;
    document.title = "Top Links";
    vi.stubGlobal("indexedDB", indexedDB);
    vi.stubGlobal("GM_getValue", (_key: string, fallback: unknown) => fallback);
    vi.stubGlobal("GM_setValue", vi.fn());
    const fetchPage = vi.fn((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const storyId = Number.parseInt(new URL(url).searchParams.get("id") ?? "", 10);
      return Promise.resolve(new Response(fetchedThreadHtml(storyId), { status: 200 }));
    });
    const scope = new LifecycleScope();
    const onActiveStoryChange = vi.fn();
    const controller = new ReaderController(document, scope, "", new ReaderWorkspaceStateStore(), {
      pageFetcher: new HnPageFetchAdapter(document, new RequestScheduler(1), fetchPage),
      threadSnapshots: new ThreadSnapshotRepository(new MemoryCacheStore<unknown>()),
      yieldToFirstPaint: () => Promise.resolve(),
      onActiveStoryChange,
    });
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
    const firstStoryLink = document.querySelector<HTMLAnchorElement>("#story-100");
    const secondStoryLink = document.querySelector<HTMLAnchorElement>("#story-200");
    if (!firstStoryLink || !secondStoryLink) throw new Error("story links were not rendered");
    firstStoryLink.focus();

    await controller.openItem(100);
    expect(onActiveStoryChange).toHaveBeenLastCalledWith(100);
    expect(document.title).toBe("Story 100");
    const workspace = document.querySelector("#hn-reader-workspace");
    const hostScroller = document.querySelector<HTMLElement>("body > center");
    if (!hostScroller) throw new Error("host scroller was not rendered");
    hostScroller.scrollTop = 640;
    const restoreOldFocus = vi.spyOn(firstStoryLink, "focus");
    secondStoryLink.focus();

    await controller.open(200 as never);
    await Promise.resolve();

    expect(document.querySelector("#hn-reader-workspace")).toBe(workspace);
    expect(hostScroller.scrollTop).toBe(640);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(restoreOldFocus).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLElement>("#hn-reader-root")?.shadowRoot?.querySelector(".hnr-title-original")?.textContent)
      .toBe("Story 200");
    expect(document.title).toBe("Story 200");
    expect(onActiveStoryChange).toHaveBeenLastCalledWith(200);
    document.title = "Past Links";
    controller.syncHostDocumentTitle();
    expect(document.title).toBe("Story 200");
    controller.close();
    expect(onActiveStoryChange).toHaveBeenLastCalledWith(null);
    expect(document.title).toBe("Past Links");
    hostScroller.scrollTop = 0;
    scope.destroy();
  });

  it("records the last active story as soon as the Reader mounts", async () => {
    document.documentElement.innerHTML = readFileSync(resolve("lite/fixtures/hn-item.html"), "utf8");
    document.title = "HN Discussion";
    const stored = new Map<string, unknown>();
    vi.stubGlobal("indexedDB", indexedDB);
    vi.stubGlobal("GM_getValue", (key: string, fallback: unknown) => stored.get(key) ?? fallback);
    vi.stubGlobal("GM_setValue", (key: string, value: unknown) => { stored.set(key, value); });
    vi.stubGlobal("GM_listValues", () => [...stored.keys()]);
    const scope = new LifecycleScope();
    const theme = { apply: vi.fn() };
    const onHostNavigate = vi.fn();
    const controller = new ReaderController(document, scope, "", new ReaderWorkspaceStateStore(), {
      theme,
      onHostNavigate,
    });

    await controller.open(100 as never);
    expect(document.title).toBe("Example story");
    expect(stored.get("hn-reader:workspace-state:v2")).toMatchObject({
      readerRatio: 0.52,
      lastActiveStoryId: 100,
    });
    const readerRoot = document.querySelector<HTMLElement>("#hn-reader-root");
    const shadow = readerRoot?.shadowRoot;
    expect(theme.apply).toHaveBeenLastCalledWith("auto");
    shadow?.querySelector<HTMLButtonElement>('[data-comment-action="reply"]')?.click();
    expect(onHostNavigate).toHaveBeenCalledWith("https://news.ycombinator.com/reply?id=101");
    shadow?.querySelector<HTMLButtonElement>('[data-command="settings"]')?.click();
    const themeSelect = shadow?.querySelector<HTMLSelectElement>('.hnr-settings-sidebar-footer select[name="theme"]');
    if (!themeSelect) throw new Error("theme selector was not rendered");
    themeSelect.value = "dark";
    themeSelect.dispatchEvent(new Event("change"));
    expect(theme.apply).toHaveBeenLastCalledWith("dark");
    shadow?.querySelector<HTMLFormElement>(".hnr-settings")?.requestSubmit();
    expect(stored.get("hn-reader:settings:v1")).toMatchObject({ theme: "dark" });
    readerRoot?.shadowRoot?.querySelector<HTMLButtonElement>(".hnr-close")?.click();

    expect(stored.get("hn-reader:workspace-state:v2")).toMatchObject({
      readerRatio: 0.52,
      lastActiveStoryId: 100,
    });
    expect(document.querySelector("#hn-reader-workspace")).toBeNull();
    expect(document.title).toBe("HN Discussion");
    scope.destroy();
  });

  it("restores each topic's reply-tree collapse state and physical comment offset", async () => {
    document.documentElement.innerHTML = readFileSync(resolve("lite/fixtures/hn-item.html"), "utf8");
    const stored = new Map<string, unknown>();
    vi.stubGlobal("indexedDB", indexedDB);
    vi.stubGlobal("GM_getValue", (key: string, fallback: unknown) => stored.get(key) ?? fallback);
    vi.stubGlobal("GM_setValue", (key: string, value: unknown) => { stored.set(key, value); });
    vi.stubGlobal("GM_listValues", () => [...stored.keys()]);
    const scope = new LifecycleScope();
    const controller = new ReaderController(document, scope, "", new ReaderWorkspaceStateStore(), {
      pageFetcher: new HnPageFetchAdapter(
        document,
        new RequestScheduler(1),
        () => Promise.resolve(new Response(fetchedThreadHtml(200), { status: 200 })),
      ),
      threadSnapshots: new ThreadSnapshotRepository(new MemoryCacheStore<unknown>()),
      yieldToFirstPaint: () => Promise.resolve(),
    });

    await controller.open(100 as never);
    let shadow = document.querySelector<HTMLElement>("#hn-reader-root")?.shadowRoot;
    const collapse = shadow?.querySelector<HTMLButtonElement>(
      '.hnr-comment[data-comment-id="101"] .hnr-branch-toggle',
    );
    const viewport = shadow?.querySelector<HTMLElement>(".hnr-comments");
    if (!collapse || !viewport) throw new Error("topic controls were not rendered");
    collapse.click();
    viewport.scrollTop = 31;

    await controller.open(200 as never);
    const savedTopicState = stored.get("hn-reader:topic-state:v1:100");
    expect(savedTopicState).toMatchObject({
      schemaVersion: 1,
      position: { commentId: 101, offset: 31 },
      collapsedCommentIds: [101],
      storyTitle: "Example story",
    });
    expect(savedTopicState && typeof savedTopicState === "object"
      && "visitedAt" in savedTopicState && typeof savedTopicState.visitedAt === "number").toBe(true);

    await controller.open(100 as never);
    shadow = document.querySelector<HTMLElement>("#hn-reader-root")?.shadowRoot;
    expect(shadow?.querySelector('[data-comment-id="102"]')).toBeNull();
    expect(shadow?.querySelector<HTMLElement>(".hnr-comments")?.scrollTop).toBe(31);
    shadow?.querySelector<HTMLButtonElement>('[data-command="history"]')?.click();
    await vi.waitFor(() => expect(shadow?.querySelectorAll(".hnr-browsing-history-entry")).toHaveLength(2));
    shadow?.querySelector<HTMLButtonElement>('.hnr-browsing-history-entry[data-story-id="200"]')?.click();
    await vi.waitFor(() => expect(document.title).toBe("Story 200"));
    scope.destroy();
  });

  it("paints a cached thread before the background HN page refresh completes", async () => {
    const fixture = readFileSync(resolve("lite/fixtures/hn-item.html"), "utf8");
    const source = new DOMParser().parseFromString(fixture, "text/html");
    const threadSnapshots = new ThreadSnapshotRepository(new MemoryCacheStore<unknown>());
    await threadSnapshots.set(parseHnDocument(source));
    document.documentElement.innerHTML = "<head><base href='https://news.ycombinator.com/news'></head><body><table></table></body>";
    vi.stubGlobal("indexedDB", indexedDB);
    vi.stubGlobal("GM_getValue", (_key: string, fallback: unknown) => fallback);
    vi.stubGlobal("GM_setValue", vi.fn());

    let finishRefresh: (() => void) | undefined;
    const fetchPage = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolveRequest, rejectRequest) => {
      init?.signal?.addEventListener("abort", () => rejectRequest(
        init.signal?.reason instanceof Error ? init.signal.reason : new Error("request aborted"),
      ), { once: true });
      finishRefresh = () => resolveRequest(new Response(fixture, { status: 200 }));
    }));
    const scope = new LifecycleScope();
    const controller = new ReaderController(document, scope, "", new ReaderWorkspaceStateStore(), {
      pageFetcher: new HnPageFetchAdapter(document, new RequestScheduler(1), fetchPage),
      threadSnapshots,
    });

    expect(finishRefresh).toBeUndefined();
    const opening = controller.open(100 as never);
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#hn-reader-root")?.shadowRoot?.querySelector(".hnr-title-original")?.textContent)
        .toBe("Example story");
    });
    await vi.waitFor(() => expect(finishRefresh).toBeTypeOf("function"));

    finishRefresh?.();
    await opening;
    scope.destroy();
  });

  it("enters the Reader shell before an uncached HN comment page finishes loading", async () => {
    const fixture = readFileSync(resolve("lite/fixtures/hn-item.html"), "utf8");
    document.documentElement.innerHTML = `
      <head><base href="https://news.ycombinator.com/news"></head>
      <body><table>
        <tr class="athing" id="100"><td class="title"><span class="titleline"><a href="https://example.com/article">Example story</a></span></td></tr>
        <tr><td class="subtext"><span class="score">42 points</span> by <a class="hnuser">alice</a> | <a class="comments">4 comments</a></td></tr>
      </table></body>`;
    vi.stubGlobal("indexedDB", indexedDB);
    vi.stubGlobal("GM_getValue", (_key: string, fallback: unknown) => fallback);
    vi.stubGlobal("GM_setValue", vi.fn());

    let finishPage: (() => void) | undefined;
    let releasePaint: (() => void) | undefined;
    const fetchPage = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((resolveRequest, rejectRequest) => {
      init?.signal?.addEventListener("abort", () => rejectRequest(
        init.signal?.reason instanceof Error ? init.signal.reason : new Error("request aborted"),
      ), { once: true });
      finishPage = () => resolveRequest(new Response(fixture, { status: 200 }));
    }));
    const scope = new LifecycleScope();
    const controller = new ReaderController(document, scope, "", new ReaderWorkspaceStateStore(), {
      pageFetcher: new HnPageFetchAdapter(document, new RequestScheduler(1), fetchPage),
      threadSnapshots: new ThreadSnapshotRepository(new MemoryCacheStore<unknown>()),
      yieldToFirstPaint: () => new Promise<void>((resolvePaint) => { releasePaint = resolvePaint; }),
    });

    const opening = controller.open(100 as never);
    await vi.waitFor(() => {
      const shadow = document.querySelector<HTMLElement>("#hn-reader-root")?.shadowRoot;
      expect(shadow?.querySelector(".hnr-title-original")?.textContent).toBe("Example story");
      expect(shadow?.querySelector(".hnr-status")?.textContent).toContain("已进入 Reader");
    });
    expect(finishPage).toBeUndefined();
    expect(releasePaint).toBeUndefined();

    await vi.waitFor(() => expect(finishPage).toBeTypeOf("function"));
    finishPage?.();
    await vi.waitFor(() => expect(releasePaint).toBeTypeOf("function"));
    expect(document.querySelector<HTMLElement>("#hn-reader-root")?.shadowRoot?.querySelector(".hnr-coverage")?.textContent)
      .toContain("4 条评论");
    releasePaint?.();
    await opening;
    scope.destroy();
  });

  it("announces only comments whose HN creation time is after this Reader session opened", async () => {
    const openedAt = Date.now();
    const fixture = threadHtmlAroundReaderOpen(openedAt);
    document.documentElement.innerHTML = `
      <head><base href="https://news.ycombinator.com/news"></head>
      <body><table>
        <tr class="athing" id="100"><td class="title"><span class="titleline"><a href="https://example.com/article">Example story</a></span></td></tr>
        <tr><td class="subtext"><span class="score">42 points</span> by <a class="hnuser">alice</a> | <a class="comments">2 comments</a></td></tr>
      </table></body>`;
    vi.stubGlobal("indexedDB", indexedDB);
    vi.stubGlobal("GM_getValue", (_key: string, fallback: unknown) => fallback);
    vi.stubGlobal("GM_setValue", vi.fn());
    const scope = new LifecycleScope();
    const controller = new ReaderController(document, scope, "", new ReaderWorkspaceStateStore(), {
      pageFetcher: new HnPageFetchAdapter(
        document,
        new RequestScheduler(1),
        vi.fn(() => Promise.resolve(new Response(fixture, { status: 200 }))),
      ),
      threadSnapshots: new ThreadSnapshotRepository(new MemoryCacheStore<unknown>()),
      yieldToFirstPaint: () => Promise.resolve(),
    });

    await controller.open(100 as never);
    const shadow = document.querySelector<HTMLElement>("#hn-reader-root")?.shadowRoot;
    const notice = shadow?.querySelector<HTMLElement>(".hnr-new-comments-notice");
    expect(notice?.textContent).toContain("新评论 1/1");
    expect(notice?.textContent).toContain("after");
    expect(shadow?.querySelector<HTMLElement>('.hnr-new-comments-current')?.dataset.commentId).toBe("102");
    expect(shadow?.querySelector<HTMLElement>('.hnr-comment[data-comment-id="101"]')?.hasAttribute("data-new-comment")).toBe(false);
    expect(shadow?.querySelector<HTMLElement>('.hnr-comment[data-comment-id="102"]')?.dataset.newComment).toBe("true");
    scope.destroy();
  });

  it("automatically syncs a new comment from the HN realtime stream", async () => {
    const openedAt = Date.now();
    document.documentElement.innerHTML = `
      <head><base href="https://news.ycombinator.com/news"></head>
      <body><table>
        <tr class="athing" id="100"><td class="title"><span class="titleline"><a href="https://example.com/article">Example story</a></span></td></tr>
        <tr><td class="subtext"><span class="score">42 points</span> by <a class="hnuser">alice</a> | <a class="comments">1 comment</a></td></tr>
      </table></body>`;
    const page = translationThreadHtml(1);
    vi.stubGlobal("indexedDB", indexedDB);
    vi.stubGlobal("GM_getValue", (_key: string, fallback: unknown) => fallback);
    vi.stubGlobal("GM_setValue", vi.fn());
    const source = new FakeHnRealtimeSource();
    const converter = new HnApiAdapter({ request: vi.fn(() => Promise.reject(new Error("unexpected request"))) });
    const storyItem: HnItem = {
      id: 100, type: "story", by: "alice", time: null, text: "", parent: null,
      kids: [101, 102], deleted: false, dead: false, url: "https://example.com/article",
      title: "Example story", score: 42, descendants: 2,
    };
    const newComment: Comment = {
      id: 102 as never,
      storyId: 100 as never,
      parentId: 100 as never,
      childIds: Object.freeze([]),
      rank: 1,
      author: "realtime-user",
      createdAt: openedAt + 1_000,
      html: "Realtime comment",
      text: "Realtime comment",
      deleted: false,
      dead: false,
      source: "api",
      observedAt: openedAt + 1_000,
    };
    const sessionApi = {
      getItem: vi.fn(() => Promise.resolve(storyItem)),
      loadCommentSubtrees: vi.fn(() => Promise.resolve(Object.freeze([newComment]))),
      loadThread: vi.fn(),
      toStory: converter.toStory.bind(converter),
      toComment: converter.toComment.bind(converter),
    };
    const scope = new LifecycleScope();
    const controller = new ReaderController(document, scope, "", new ReaderWorkspaceStateStore(), {
      pageFetcher: new HnPageFetchAdapter(
        document,
        new RequestScheduler(1),
        vi.fn(() => Promise.resolve(new Response(page, { status: 200 }))),
      ),
      threadSnapshots: new ThreadSnapshotRepository(new MemoryCacheStore<unknown>()),
      yieldToFirstPaint: () => Promise.resolve(),
      realtime: new HnRealtimeAdapter(() => source),
      sessionApi,
    });

    await controller.open(100 as never);
    source.emitItems([100]);
    await vi.waitFor(() => {
      const shadow = document.querySelector<HTMLElement>("#hn-reader-root")?.shadowRoot;
      expect(shadow?.querySelector(".hnr-coverage")?.textContent).toContain("2 条评论");
      expect(shadow?.querySelector(".hnr-new-comments-notice")?.textContent).toContain("realtime-user");
    });
    expect(sessionApi.getItem).toHaveBeenCalledWith(100, expect.any(AbortSignal), true);
    expect(sessionApi.loadCommentSubtrees).toHaveBeenCalledOnce();
    scope.destroy();
    expect(source.closed).toBe(true);
  });

  it("keeps in-flight translations and appends newly visible comments after scrolling", async () => {
    document.documentElement.innerHTML = translationThreadHtml(200).replaceAll("Comment ", "Scroll comment ");
    vi.stubGlobal("indexedDB", indexedDB);
    vi.stubGlobal("GM_getValue", (key: string, fallback: unknown) => key === "hn-reader:settings:v1"
      ? { ...DEFAULT_SETTINGS, translationEnabled: true }
      : fallback);
    vi.stubGlobal("GM_setValue", vi.fn());
    const requests: GmRequestOptions[] = [];
    let abortedRequests = 0;
    vi.stubGlobal("GM_xmlhttpRequest", (options: GmRequestOptions): GmRequestHandle => {
      requests.push(options);
      return { abort: () => {
        abortedRequests += 1;
        options.onabort();
      } };
    });
    const scope = new LifecycleScope();
    const controller = new ReaderController(document, scope, "", new ReaderWorkspaceStateStore());

    await controller.open(100 as never);
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
    const viewport = document.querySelector<HTMLElement>("#hn-reader-root")?.shadowRoot?.querySelector<HTMLElement>(".hnr-comments");
    if (!viewport) throw new Error("reader viewport was not rendered");
    viewport.scrollTop = 15_000;
    viewport.dispatchEvent(new Event("scroll"));

    let responded = 0;
    for (let turn = 0; turn < 20; turn += 1) {
      while (responded < requests.length) {
        const request = requests[responded];
        responded += 1;
        if (!request) continue;
        const sources = new URL(request.url).searchParams.getAll("q");
        request.onload({
          status: 200,
          statusText: "OK",
          responseHeaders: "content-type: application/json",
          responseText: JSON.stringify(sources.map((source) => [source])),
          finalUrl: request.url,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
      const laterSources = requests.flatMap((request) => new URL(request.url).searchParams.getAll("q"));
      if (laterSources.some((source) => /Scroll comment (?:[5-9]\d|1\d\d|200)\b/.test(source))) break;
    }
    const laterSources = requests.flatMap((request) => new URL(request.url).searchParams.getAll("q"));
    expect(laterSources.some((source) => /Scroll comment (?:[5-9]\d|1\d\d|200)\b/.test(source))).toBe(true);
    expect(document.querySelector<HTMLElement>("#hn-reader-root")?.shadowRoot?.querySelector(".hnr-status")?.textContent)
      .toContain("翻译进度");
    expect(abortedRequests).toBe(0);
    scope.destroy();
  });

  it("starts persisted translation in the same turn that the first comment body mounts", async () => {
    document.documentElement.innerHTML = translationThreadHtml(4);
    vi.stubGlobal("indexedDB", indexedDB);
    vi.stubGlobal("GM_getValue", (key: string, fallback: unknown) => key === "hn-reader:settings:v1"
      ? { ...DEFAULT_SETTINGS, translationEnabled: true }
      : fallback);
    vi.stubGlobal("GM_setValue", vi.fn());
    vi.stubGlobal("GM_xmlhttpRequest", (options: GmRequestOptions): GmRequestHandle => ({ abort: () => options.onabort() }));
    let releasePaint: (() => void) | undefined;
    const scope = new LifecycleScope();
    const controller = new ReaderController(document, scope, "", new ReaderWorkspaceStateStore(), {
      yieldToFirstPaint: () => new Promise<void>((resolvePaint) => { releasePaint = resolvePaint; }),
    });

    const opening = controller.open(100 as never);
    const status = document.querySelector<HTMLElement>("#hn-reader-root")?.shadowRoot?.querySelector<HTMLElement>(".hnr-status");
    expect(status?.textContent).toContain("准备翻译当前窗口");
    expect(releasePaint).toBeTypeOf("function");
    releasePaint?.();
    await opening;
    scope.destroy();
  });

  it("does not let throttled animation frames stall the post-paint reader pipeline", async () => {
    document.documentElement.innerHTML = translationThreadHtml(4);
    vi.stubGlobal("indexedDB", indexedDB);
    vi.stubGlobal("GM_getValue", (_key: string, fallback: unknown) => fallback);
    vi.stubGlobal("GM_setValue", vi.fn());
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const scope = new LifecycleScope();
    const controller = new ReaderController(document, scope, "", new ReaderWorkspaceStateStore());

    await controller.open(100 as never);

    expect(requestFrame).toHaveBeenCalled();
    expect(cancelFrame).toHaveBeenCalledWith(1);
    expect(document.querySelector<HTMLElement>("#hn-reader-root")?.shadowRoot?.querySelector(".hnr-coverage")?.textContent)
      .toContain("4 条评论");
    scope.destroy();
  });

  it("translates the full current snapshot before downloading offline HTML", async () => {
    document.documentElement.innerHTML = translationThreadHtml(8);
    vi.stubGlobal("indexedDB", indexedDB);
    vi.stubGlobal("GM_getValue", (key: string, fallback: unknown) => key === "hn-reader:settings:v1"
      ? {
          ...DEFAULT_SETTINGS,
          titleFontFamily: "custom",
          titleCustomFontFamily: "Source Han Serif SC",
          fontFamily: "custom",
          customFontFamily: "HarmonyOS Sans SC",
          fontScale: 1.18,
        }
      : fallback);
    vi.stubGlobal("GM_setValue", vi.fn());
    const translatedSources: string[] = [];
    vi.stubGlobal("GM_xmlhttpRequest", (options: GmRequestOptions): GmRequestHandle => {
      let aborted = false;
      const sources = new URL(options.url).searchParams.getAll("q");
      translatedSources.push(...sources);
      queueMicrotask(() => {
        if (aborted) return;
        options.onload({
          status: 200,
          statusText: "OK",
          responseHeaders: "content-type: application/json",
          responseText: JSON.stringify(sources.map((source) => [`译文：${source}`])),
          finalUrl: options.url,
        });
      });
      return {
        abort: () => {
          aborted = true;
          options.onabort();
        },
      };
    });
    const NativeUrl = URL;
    class OfflineTestUrl extends NativeUrl {}
    let downloadedBlob: Blob | null = null;
    const createObjectURL = vi.fn((blob: Blob) => {
      downloadedBlob = blob;
      return "blob:hn-reader-offline";
    });
    Object.defineProperties(OfflineTestUrl, {
      createObjectURL: { value: createObjectURL },
      revokeObjectURL: { value: vi.fn() },
    });
    vi.stubGlobal("URL", OfflineTestUrl);
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const scope = new LifecycleScope();
    const controller = new ReaderController(document, scope, "", new ReaderWorkspaceStateStore());

    await controller.open(100 as never);
    const shadow = document.querySelector<HTMLElement>("#hn-reader-root")?.shadowRoot;
    shadow?.querySelector<HTMLButtonElement>('[data-command="offline"]')?.click();

    await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce(), { timeout: 3_000 });
    expect(translatedSources.filter((source) => source.startsWith("Comment "))).toHaveLength(8);
    const blob = downloadedBlob;
    if (!blob) throw new Error("离线下载没有生成 Blob");
    const downloadedHtml = await new Promise<string>((resolveText, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        if (typeof reader.result === "string") resolveText(reader.result);
        else reject(new Error("离线 Blob 未返回文本"));
      });
      reader.addEventListener("error", () => reject(reader.error ?? new Error("读取离线 Blob 失败")));
      reader.readAsText(blob);
    });
    expect(downloadedHtml).toContain('<span class="hnr-title-subtitle" lang="zh-CN">');
    expect(downloadedHtml).toContain('--hnr-title-font-family:"Source Han Serif SC",system-ui');
    expect(downloadedHtml).toContain('--hnr-content-font-family:"HarmonyOS Sans SC",system-ui');
    expect(downloadedHtml).toContain("--hnr-font-scale:1.18");
    expect(shadow?.querySelector(".hnr-status")?.textContent).toContain("8 条评论，8 条含译文");
    expect(shadow?.querySelector('[data-summary-tab="downloads"]')?.textContent).toContain("下载历史 1");
    expect(shadow?.querySelector(".hnr-download-progress")?.getAttribute("data-status")).toBe("ready");
    expect(shadow?.querySelectorAll('.hnr-download-stage[data-state="done"]')).toHaveLength(3);
    expect(shadow?.querySelector(".hnr-download-history-detail")?.textContent).toContain("-hn-100.html");

    shadow?.querySelector<HTMLButtonElement>(".hnr-download-history-action")?.click();
    await vi.waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(2));
    expect(anchorClick).toHaveBeenCalledTimes(2);
    const deleteHistory = shadow?.querySelector<HTMLButtonElement>(".hnr-download-history-delete");
    deleteHistory?.click();
    expect(deleteHistory?.dataset.confirm).toBe("true");
    deleteHistory?.click();
    await vi.waitFor(() => expect(shadow?.querySelector('[data-summary-tab="downloads"]')?.textContent).toContain("下载历史 0"));
    expect(shadow?.querySelector(".hnr-status")?.textContent).toContain("已删除下载历史");
    scope.destroy();
  });
});
