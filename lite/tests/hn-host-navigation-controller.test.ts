// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://news.ycombinator.com/news" }

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HnHostController } from "../src/host/hn-host-controller";
import { HnHostNavigationController } from "../src/host/hn-host-navigation-controller";
import { LifecycleScope } from "../src/kernel/lifecycle";
import { RequestScheduler } from "../src/network/request-scheduler";

function navigation(selectedPath: string): string {
  return [
    ["newswelcome.html", "welcome"],
    ["newest", "new"],
    ["threads", "threads"],
    ["front", "past"],
    ["newcomments", "comments"],
    ["ask", "ask"],
    ["show", "show"],
    ["jobs", "jobs"],
    ["submit", "submit"],
  ].map(([path, label]) => path === selectedPath
    ? `<span class="topsel"><a href="${path}">${label}</a></span>`
    : `<a href="${path}">${label}</a>`).join(" | ");
}

function listPage(title: string, storyId: number, selectedPath: string): string {
  return `<html op="${selectedPath}"><head><title>${title}</title><base href="https://news.ycombinator.com/"></head>
    <body><center><table id="hnmain"><tbody>
      <tr><td><table><tbody><tr>
        <td><a href="news"><img src="y18.svg" alt="Y"></a></td>
        <td><span class="pagetop">${navigation(selectedPath)}</span></td>
        <td><span class="pagetop"><a href="user?id=tester">tester</a> | <a href="logout">logout</a></span></td>
      </tr></tbody></table></td></tr>
      <tr id="pagespace"><td></td></tr>
      <tr id="bigbox"><td><table><tbody>
        <tr class="athing" id="${storyId}"><td class="title"></td><td class="votelinks"></td><td class="title"><span class="titleline"><a href="https://example.com/${storyId}">Story ${storyId}</a></span></td></tr>
        <tr><td></td><td class="subtext"><a href="item?id=${storyId}">1 comment</a></td></tr>
        <tr><td><a class="morelink" href="${selectedPath}?p=2">More</a></td></tr>
      </tbody></table></td></tr>
      <tr><td><form id="native-footer">Search</form></td></tr>
    </tbody></table></center></body></html>`;
}

function genericPage(title: string, selectedPath: string, contentId: string): Document {
  return new DOMParser().parseFromString(`<html op="${selectedPath}"><head><title>${title}</title></head>
    <body><center><table id="hnmain"><tbody>
      <tr><td><table><tbody><tr>
        <td><a href="news"><img src="y18.svg" alt="Y"></a></td>
        <td><span class="pagetop">${navigation(selectedPath)}</span></td>
        <td><span class="pagetop"><a href="user?id=tester">tester</a> | <a href="logout">logout</a></span></td>
      </tr></tbody></table></td></tr>
      <tr><td><main id="${contentId}">${title}</main></td></tr>
    </tbody></table></center></body></html>`, "text/html");
}

function commentsPage(): Document {
  return new DOMParser().parseFromString(`<html op="newcomments"><head><title>New Comments</title><base href="https://news.ycombinator.com/"></head>
    <body><center><table id="hnmain"><tbody>
      <tr><td><table><tbody><tr>
        <td><a href="news"><img src="y18.svg" alt="Y"></a></td>
        <td><span class="pagetop">${navigation("newcomments")}</span></td>
        <td><span class="pagetop"><a href="user?id=tester">tester</a></span></td>
      </tr></tbody></table></td></tr>
      <tr id="bigbox"><td><table><tbody>
        <tr class="athing" id="49327487"><td class="ind"></td><td class="votelinks"></td><td class="default"><div><span class="comhead"><a class="hnuser">alice</a><span class="navs"> | <a href="item?id=42">parent</a></span><span class="onstory"> | on: <a href="item?id=777">Story</a></span></span></div><br><div class="comment"><div class="commtext">A new comment.</div></div></td></tr>
        <tr class="spacer"></tr>
      </tbody></table></td></tr>
    </tbody></table></center></body></html>`, "text/html");
}

describe("HnHostNavigationController", () => {
  beforeEach(() => document.documentElement.classList.add("hnr-reader-embedded-right"));
  afterEach(() => document.documentElement.classList.remove("hnr-reader-embedded-right"));

  it("leaves topbar tabs native while Reader is closed", () => {
    history.replaceState({}, "", "https://news.ycombinator.com/front");
    document.documentElement.innerHTML = listPage("Past Links", 42, "front");
    document.documentElement.classList.remove("hnr-reader-embedded-right");
    const scope = new LifecycleScope();
    const host = new HnHostController(document, { kind: "list" }, vi.fn(), "", scope);
    host.install();
    const load = vi.fn();
    new HnHostNavigationController(document, { load }, host, vi.fn(), scope).install();
    const newest = document.querySelector<HTMLAnchorElement>('a[href="newest"]');
    const nativeTarget = vi.fn((event: Event) => event.preventDefault());
    newest?.addEventListener("click", nativeTarget, { once: true });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });

    newest?.dispatchEvent(click);

    expect(nativeTarget).toHaveBeenCalledOnce();
    expect(load).not.toHaveBeenCalled();
    scope.destroy();
  });

  it("switches new and past inside the host pane with real topsel anchors", async () => {
    history.replaceState({}, "", "https://news.ycombinator.com/newest");
    document.documentElement.innerHTML = listPage("New Links", 42, "newest");
    const readerMount = document.createElement("div");
    readerMount.id = "reader-mount";
    document.documentElement.append(readerMount);
    const main = document.querySelector("#hnmain");
    const scope = new LifecycleScope();
    const host = new HnHostController(document, { kind: "list" }, vi.fn(), "", scope);
    host.install();
    const frontPage = new DOMParser().parseFromString(
      listPage("Past Links", 43, "front"),
      "text/html",
    );
    const load = vi.fn(() => Promise.resolve({
      document: frontPage,
      finalUrl: "https://news.ycombinator.com/front",
    }));
    const onHostReplaced = vi.fn();
    new HnHostNavigationController(
      document,
      { load },
      host,
      onHostReplaced,
      scope,
    ).install();

    const past = document.querySelector<HTMLAnchorElement>('a[href="front"]');
    expect(document.querySelector('[data-hnr-topbar-active="true"]')?.textContent).toBe("new");
    past?.addEventListener("click", (event) => event.stopPropagation());
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    past?.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(location.pathname).toBe("/front"));
    expect(load).toHaveBeenCalledWith(
      "https://news.ycombinator.com/front",
      expect.any(AbortSignal),
    );
    expect(document.querySelector("#hnmain")).toBe(main);
    expect(document.getElementById("reader-mount")).toBe(readerMount);
    expect(document.querySelector('[data-hnr-card-open="43"]')).not.toBeNull();
    expect(document.querySelector(".topsel > a")?.textContent).toBe("past");
    expect(document.querySelector('[data-hnr-topbar-active="true"]')?.textContent).toBe("past");
    expect(document.documentElement.getAttribute("op")).toBe("front");
    expect(onHostReplaced).toHaveBeenCalledOnce();
    scope.destroy();
    readerMount.remove();
  });

  it("opens item links in Reader without replacing the current host tab or URL", () => {
    history.replaceState({}, "", "https://news.ycombinator.com/news");
    document.documentElement.innerHTML = listPage("Top Links", 42, "news");
    const scope = new LifecycleScope();
    const host = new HnHostController(document, { kind: "list" }, vi.fn(), "", scope);
    host.install();
    const load = vi.fn();
    const onOpenItem = vi.fn();
    new HnHostNavigationController(
      document,
      { load },
      host,
      vi.fn(),
      scope,
      () => undefined,
      onOpenItem,
    ).install();

    const link = document.querySelector<HTMLAnchorElement>('.subtext a[href="item?id=42"]');
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link?.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    expect(onOpenItem).toHaveBeenCalledOnce();
    expect(onOpenItem).toHaveBeenCalledWith(42);
    expect(load).not.toHaveBeenCalled();
    expect(location.pathname).toBe("/news");
    expect(document.querySelector('[data-hnr-card-open="42"]')).not.toBeNull();
    scope.destroy();
  });

  it("can replace an initial item-page host with the default tab while preserving the item URL", async () => {
    history.replaceState({}, "", "https://news.ycombinator.com/item?id=42");
    document.documentElement.innerHTML = listPage("Item Page", 42, "item");
    const scope = new LifecycleScope();
    const host = new HnHostController(
      document,
      { kind: "item", itemId: 42 },
      vi.fn(),
      "",
      scope,
    );
    host.install();
    const newsPage = new DOMParser().parseFromString(
      listPage("Top Links", 43, "news"),
      "text/html",
    );
    const load = vi.fn(() => Promise.resolve({
      document: newsPage,
      finalUrl: "https://news.ycombinator.com/news",
    }));
    const navigationController = new HnHostNavigationController(
      document,
      { load },
      host,
      vi.fn(),
      scope,
    );

    await expect(navigationController.showHostPage("/news")).resolves.toBe(true);

    expect(location.pathname).toBe("/item");
    expect(location.search).toBe("?id=42");
    expect(document.querySelector('[data-hnr-card-open="43"]')).not.toBeNull();
    scope.destroy();
  });

  it("does not import non-tab read-only pages into the host pane", () => {
    history.replaceState({}, "", "https://news.ycombinator.com/news");
    document.documentElement.innerHTML = listPage("Top Links", 42, "news");
    const scope = new LifecycleScope();
    const host = new HnHostController(document, { kind: "list" }, vi.fn(), "", scope);
    host.install();
    const load = vi.fn();
    const onOpenItem = vi.fn();
    new HnHostNavigationController(
      document,
      { load },
      host,
      vi.fn(),
      scope,
      () => undefined,
      onOpenItem,
    ).install();
    const profile = document.querySelector<HTMLAnchorElement>('a[href="user?id=tester"]');
    profile?.addEventListener("click", (event) => event.preventDefault(), { once: true });

    profile?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(load).not.toHaveBeenCalled();
    expect(onOpenItem).not.toHaveBeenCalled();
    expect(document.querySelector('[data-hnr-card-open="42"]')).not.toBeNull();
    scope.destroy();
  });

  it("restarts a rapidly repeated tab navigation without surfacing the replaced request", async () => {
    history.replaceState({}, "", "https://news.ycombinator.com/newcomments");
    document.documentElement.innerHTML = commentsPage().documentElement.innerHTML;
    const scope = new LifecycleScope();
    const host = new HnHostController(document, { kind: "comments" }, vi.fn(), "", scope);
    host.install();
    const scheduler = new RequestScheduler(1);
    const frontPage = new DOMParser().parseFromString(
      listPage("Past Links", 43, "front"),
      "text/html",
    );
    const run = vi.fn((signal: AbortSignal) => (
      run.mock.calls.length === 1
        ? new Promise<{ document: Document; finalUrl: string }>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(
              signal.reason instanceof Error ? signal.reason : new Error("navigation aborted"),
            ), { once: true });
          })
        : Promise.resolve({
            document: frontPage,
            finalUrl: "https://news.ycombinator.com/front",
          })
    ));
    const loader = {
      load: (rawUrl: string, signal?: AbortSignal) => scheduler.schedule({
        key: `host:${rawUrl}`,
        lane: "hn-interactive",
        ...(signal ? { signal } : {}),
        run,
      }),
    };
    const navigationController = new HnHostNavigationController(
      document,
      loader,
      host,
      vi.fn(),
      scope,
    );
    navigationController.install();

    const first = navigationController.navigate("/front");
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    const second = navigationController.navigate("/front");

    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    expect(location.pathname).toBe("/front");
    expect(document.querySelector('[data-hnr-card-open="43"]')).not.toBeNull();
    expect(document.querySelector(".hnr-host-navigation-notice")).toBeNull();
    scheduler.destroy();
    scope.destroy();
  });

  it("shows a cached tab immediately, then refreshes and reports the background update", async () => {
    history.replaceState({}, "", "https://news.ycombinator.com/news");
    document.documentElement.innerHTML = listPage("Top Links", 42, "news");
    const scope = new LifecycleScope();
    const host = new HnHostController(document, { kind: "list" }, vi.fn(), "", scope);
    host.install();
    const cachedFront = new DOMParser().parseFromString(
      listPage("Past Links Cached", 43, "front"),
      "text/html",
    );
    const newestPage = new DOMParser().parseFromString(
      listPage("New Links", 44, "newest"),
      "text/html",
    );
    const refreshedFront = new DOMParser().parseFromString(
      listPage("Past Links Refreshed", 45, "front"),
      "text/html",
    );
    let resolveRefresh: ((page: {
      document: Document;
      finalUrl: string;
    }) => void) | undefined;
    const load = vi.fn()
      .mockResolvedValueOnce({
        document: cachedFront,
        finalUrl: "https://news.ycombinator.com/front",
      })
      .mockResolvedValueOnce({
        document: newestPage,
        finalUrl: "https://news.ycombinator.com/newest",
      })
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveRefresh = resolve;
      }));
    new HnHostNavigationController(document, { load }, host, vi.fn(), scope).install();

    document.querySelector<HTMLAnchorElement>('a[href="front"]')?.click();
    await vi.waitFor(() => expect(document.querySelector('[data-hnr-card-open="43"]'))
      .not.toBeNull());
    document.querySelector<HTMLAnchorElement>('a[href="newest"]')?.click();
    await vi.waitFor(() => expect(document.querySelector('[data-hnr-card-open="44"]'))
      .not.toBeNull());

    document.querySelector<HTMLAnchorElement>('a[href="front"]')?.click();

    expect(location.pathname).toBe("/front");
    expect(document.querySelector('[data-hnr-card-open="43"]')).not.toBeNull();
    expect(document.querySelector("body > center")?.hasAttribute("aria-busy")).toBe(false);
    expect(load).toHaveBeenCalledTimes(3);
    const hostScroller = document.querySelector<HTMLElement>("body > center");
    if (hostScroller) hostScroller.scrollTop = 240;
    resolveRefresh?.({
      document: refreshedFront,
      finalUrl: "https://news.ycombinator.com/front",
    });

    await vi.waitFor(() => expect(document.querySelector('[data-hnr-card-open="45"]'))
      .not.toBeNull());
    expect(hostScroller?.scrollTop).toBe(240);
    expect(document.querySelector(".hnr-host-navigation-notice")?.textContent)
      .toBe("页面已后台更新");
    expect(document.querySelector(".hnr-host-navigation-notice")?.getAttribute("data-tone"))
      .toBe("success");
    scope.destroy();
  });

  it("loads other HN tabs and pages only into the host while Reader stays mounted", async () => {
    history.replaceState({}, "", "https://news.ycombinator.com/news");
    document.documentElement.innerHTML = listPage("Top Links", 42, "news");
    const readerMount = document.createElement("div");
    readerMount.id = "reader-mount";
    document.documentElement.append(readerMount);
    const main = document.querySelector("#hnmain");
    const scope = new LifecycleScope();
    const host = new HnHostController(document, { kind: "list" }, vi.fn(), "", scope);
    host.install();
    const submitPage = genericPage("Submit", "submit", "submit-page");
    const submitNavigation = submitPage.querySelector("#hnmain > tbody > tr:first-child table > tbody > tr > td:nth-child(2)");
    submitNavigation?.replaceChildren();
    const sparseNavigation = submitPage.createElement("span");
    sparseNavigation.className = "pagetop";
    sparseNavigation.innerHTML = "<b>Submit</b>";
    submitNavigation?.append(sparseNavigation);
    const load = vi.fn(() => Promise.resolve({
      document: submitPage,
      finalUrl: "https://news.ycombinator.com/submit",
    }));
    new HnHostNavigationController(document, { load }, host, vi.fn(), scope).install();

    document.querySelector<HTMLAnchorElement>('a[href="submit"]')?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    await vi.waitFor(() => expect(location.pathname).toBe("/submit"));
    expect(document.querySelector("#hnmain")).toBe(main);
    expect(document.getElementById("submit-page")).not.toBeNull();
    expect(document.getElementById("reader-mount")).toBe(readerMount);
    expect(document.documentElement.classList.contains("hnr-host-list")).toBe(false);
    expect(document.querySelector("[data-hnr-card-open]")).toBeNull();
    expect([...document.querySelectorAll<HTMLAnchorElement>("[data-hnr-topbar-navigation] a")]
      .map((anchor) => anchor.textContent)).toEqual([
      "welcome", "new", "threads", "past", "comments", "ask", "show", "jobs", "submit",
    ]);
    expect(document.querySelector('[data-hnr-topbar-active="true"]')?.textContent).toBe("submit");
    scope.destroy();
    readerMount.remove();
  });

  it("fills the signed-in username for a bare threads tab before loading", async () => {
    history.replaceState({}, "", "https://news.ycombinator.com/news");
    document.documentElement.innerHTML = listPage("Top Links", 42, "news");
    const scope = new LifecycleScope();
    const host = new HnHostController(document, { kind: "list" }, vi.fn(), "", scope);
    host.install();
    const threadsPage = genericPage("tester's comments", "threads", "threads-page");
    const load = vi.fn(() => Promise.resolve({
      document: threadsPage,
      finalUrl: "https://news.ycombinator.com/threads?id=tester",
    }));
    new HnHostNavigationController(document, { load }, host, vi.fn(), scope).install();

    document.querySelector<HTMLAnchorElement>('a[href="threads"]')?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    await vi.waitFor(() => expect(document.getElementById("threads-page")).not.toBeNull());
    expect(load).toHaveBeenCalledWith(
      "https://news.ycombinator.com/threads?id=tester",
      expect.any(AbortSignal),
    );
    expect(location.pathname).toBe("/threads");
    expect(location.search).toBe("?id=tester");
    expect(document.documentElement.classList.contains("hnr-host-comments")).toBe(true);
    scope.destroy();
  });

  it("renders standalone welcome pages inside the existing host shell", async () => {
    history.replaceState({}, "", "https://news.ycombinator.com/news");
    document.documentElement.innerHTML = listPage("Top Links", 42, "news");
    const readerMount = document.createElement("div");
    readerMount.id = "reader-mount";
    document.documentElement.append(readerMount);
    const main = document.querySelector("#hnmain");
    const scope = new LifecycleScope();
    const host = new HnHostController(document, { kind: "list" }, vi.fn(), "", scope);
    host.install();
    const welcomePage = new DOMParser().parseFromString(
      "<html><head><title>Welcome</title></head><body><main id='welcome-copy'><a href='newsguidelines.html'>Welcome</a></main></body></html>",
      "text/html",
    );
    const load = vi.fn(() => Promise.resolve({
      document: welcomePage,
      finalUrl: "https://news.ycombinator.com/newswelcome.html",
    }));
    new HnHostNavigationController(document, { load }, host, vi.fn(), scope).install();

    document.querySelector<HTMLAnchorElement>('a[href="newswelcome.html"]')?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    await vi.waitFor(() => expect(document.getElementById("welcome-copy")).not.toBeNull());
    expect(document.querySelector("#hnmain")).toBe(main);
    expect(document.querySelector(".hnr-host-standalone")).not.toBeNull();
    expect(document.getElementById("reader-mount")).toBe(readerMount);
    expect(location.pathname).toBe("/newswelcome.html");
    scope.destroy();
    readerMount.remove();
  });

  it("loads reply forms in the host and exposes a history-backed return command", async () => {
    history.replaceState({}, "", "https://news.ycombinator.com/item?id=42");
    document.documentElement.innerHTML = listPage("Top Links", 42, "news");
    const scope = new LifecycleScope();
    const host = new HnHostController(document, { kind: "list" }, vi.fn(), "", scope);
    host.install();
    const replyPage = genericPage("Add Comment", "reply", "reply-page");
    const replyForm = replyPage.createElement("form");
    replyForm.setAttribute("action", "comment");
    replyPage.getElementById("reply-page")?.replaceChildren(replyForm);
    const load = vi.fn(() => Promise.resolve({
      document: replyPage,
      finalUrl: "https://news.ycombinator.com/reply?id=101",
    }));
    const navigation = new HnHostNavigationController(
      document,
      { load },
      host,
      vi.fn(),
      scope,
    );
    navigation.install();

    expect(await navigation.navigate("https://news.ycombinator.com/reply?id=101")).toBe(true);
    const back = document.querySelector<HTMLButtonElement>("[data-hnr-host-back]");
    expect(back?.textContent).toContain("返回讨论");
    const historyBack = vi.spyOn(history, "back").mockImplementation(() => undefined);
    back?.click();
    expect(historyBack).toHaveBeenCalledOnce();
    historyBack.mockRestore();
    expect(location.pathname).toBe("/reply");
    scope.destroy();
  });

  it("switches comments into comment cards without unmounting Reader", async () => {
    history.replaceState({}, "", "https://news.ycombinator.com/news");
    document.documentElement.innerHTML = listPage("Top Links", 42, "news");
    const readerMount = document.createElement("div");
    readerMount.id = "reader-mount";
    document.documentElement.append(readerMount);
    const scope = new LifecycleScope();
    const host = new HnHostController(document, { kind: "list" }, vi.fn(), "", scope);
    host.install();
    const load = vi.fn(() => Promise.resolve({
      document: commentsPage(),
      finalUrl: "https://news.ycombinator.com/newcomments",
    }));
    new HnHostNavigationController(document, { load }, host, vi.fn(), scope).install();

    document.querySelector<HTMLAnchorElement>('a[href="newcomments"]')?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    await vi.waitFor(() => expect(location.pathname).toBe("/newcomments"));
    expect(document.documentElement.classList.contains("hnr-host-list")).toBe(false);
    expect(document.documentElement.classList.contains("hnr-host-comments")).toBe(true);
    expect(document.querySelector('[data-hnr-comment-card="49327487"]')).not.toBeNull();
    expect(document.getElementById("reader-mount")).toBe(readerMount);
    scope.destroy();
    readerMount.remove();
  });

  it("routes HN item links inside comment cards to Reader", () => {
    history.replaceState({}, "", "https://news.ycombinator.com/newcomments");
    document.documentElement.innerHTML = commentsPage().documentElement.innerHTML;
    const scope = new LifecycleScope();
    const onOpen = vi.fn();
    const host = new HnHostController(document, { kind: "comments" }, onOpen, "", scope);
    host.install();
    const itemPage = genericPage("Parent", "item", "parent-page");
    const load = vi.fn(() => Promise.resolve({
      document: itemPage,
      finalUrl: "https://news.ycombinator.com/item?id=42",
    }));
    new HnHostNavigationController(document, { load }, host, vi.fn(), scope).install();

    const card = document.querySelector<HTMLElement>("[data-hnr-comment-card]");
    expect(card?.dataset.hnrCommentStory).toBe("777");
    const parent = card?.querySelector<HTMLAnchorElement>('a[href="item?id=42"]');
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    parent?.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(true);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith(777, 49327487);
    expect(load).not.toHaveBeenCalled();
    expect(location.pathname).toBe("/newcomments");
    scope.destroy();
  });

  it("restores host history without unmounting Reader", async () => {
    history.replaceState({}, "", "https://news.ycombinator.com/news");
    document.documentElement.innerHTML = listPage("Top Links", 42, "news");
    const readerMount = document.createElement("div");
    readerMount.id = "reader-mount";
    document.documentElement.append(readerMount);
    const scope = new LifecycleScope();
    const host = new HnHostController(document, { kind: "list" }, vi.fn(), "", scope);
    host.install();
    const backPage = new DOMParser().parseFromString(
      listPage("Top Links Restored", 44, "news"),
      "text/html",
    );
    const load = vi.fn(() => Promise.resolve({
      document: backPage,
      finalUrl: "https://news.ycombinator.com/news",
    }));
    new HnHostNavigationController(document, { load }, host, vi.fn(), scope).install();

    window.dispatchEvent(new PopStateEvent("popstate"));

    await vi.waitFor(() => expect(document.getElementById("44")).not.toBeNull());
    expect(document.getElementById("reader-mount")).toBe(readerMount);
    expect(load).toHaveBeenCalledWith(
      "https://news.ycombinator.com/news",
      expect.any(AbortSignal),
    );
    scope.destroy();
    readerMount.remove();
  });

  it("leaves card titles, modified clicks, external URLs and HN actions native", () => {
    history.replaceState({}, "", "https://news.ycombinator.com/news");
    document.documentElement.innerHTML = listPage("Top Links", 42, "news");
    const scope = new LifecycleScope();
    const host = new HnHostController(document, { kind: "list" }, vi.fn(), "", scope);
    host.install();
    const load = vi.fn();
    new HnHostNavigationController(document, { load }, host, vi.fn(), scope).install();
    const title = document.querySelector<HTMLAnchorElement>(".titleline > a");
    title?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const logout = document.querySelector<HTMLAnchorElement>('a[href="logout"]');
    logout?.addEventListener("click", (event) => event.preventDefault(), { once: true });
    logout?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    document.querySelector<HTMLAnchorElement>('a[href="newest"]')?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }),
    );
    const localHash = document.createElement("a");
    localHash.href = `${location.pathname}${location.search}#42`;
    localHash.addEventListener("click", (event) => event.preventDefault());
    document.querySelector("body > center")?.append(localHash);
    localHash.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(load).not.toHaveBeenCalled();
    scope.destroy();
  });

  it("keeps a manual More navigation inside the host pane", async () => {
    history.replaceState({}, "", "https://news.ycombinator.com/news");
    document.documentElement.innerHTML = listPage("Top Links", 42, "news");
    const scope = new LifecycleScope();
    const host = new HnHostController(document, { kind: "list" }, vi.fn(), "", scope);
    host.install();
    const nextPage = new DOMParser().parseFromString(
      listPage("Top Links Page 2", 43, "news"),
      "text/html",
    );
    const load = vi.fn(() => Promise.resolve({
      document: nextPage,
      finalUrl: "https://news.ycombinator.com/news?p=2",
    }));
    new HnHostNavigationController(document, { load }, host, vi.fn(), scope).install();

    document.querySelector<HTMLAnchorElement>(".morelink")?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    await vi.waitFor(() => expect(location.search).toBe("?p=2"));
    expect(document.querySelector('[data-hnr-card-open="43"]')).not.toBeNull();
    scope.destroy();
  });

  it("keeps the current host and reports a silent navigation failure", async () => {
    history.replaceState({}, "", "https://news.ycombinator.com/news");
    document.documentElement.innerHTML = listPage("Top Links", 42, "news");
    const scope = new LifecycleScope();
    const host = new HnHostController(document, { kind: "list" }, vi.fn(), "", scope);
    host.install();
    const load = vi.fn(() => Promise.reject(new Error("network unavailable")));
    new HnHostNavigationController(document, { load }, host, vi.fn(), scope).install();

    document.querySelector<HTMLAnchorElement>('a[href="newest"]')?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );

    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(document.querySelector(".hnr-host-navigation-notice"))
      .not.toBeNull());
    expect(document.querySelector('[data-hnr-card-open="42"]')).not.toBeNull();
    expect(location.pathname).toBe("/news");
    expect(document.querySelector("body > center")?.hasAttribute("aria-busy")).toBe(false);
    scope.destroy();
  });
});
