// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { HnHostController, installHnHostAppearance } from "../src/host/hn-host-controller";
import { LifecycleScope } from "../src/kernel/lifecycle";
import type { StoryId } from "../src/thread/model";

describe("HnHostController", () => {
  it("opens the first story title tooltip below the frozen host header", () => {
    const css = readFileSync(resolve("lite/styles/05-host.css"), "utf8");

    expect(css).toContain(
      "table.itemlist > tbody > tr[data-hnr-card-open]:first-child .hnr-host-title-tooltip",
    );
    expect(css).toMatch(
      /tr\[data-hnr-card-open\]:first-child \.hnr-host-title-tooltip \{[\s\S]*?top: calc\(100% \+ 7px\);[\s\S]*?bottom: auto;/,
    );
  });

  it("wraps narrow topbar tabs and keeps embedded native forms inside the host pane", () => {
    const css = readFileSync(resolve("lite/styles/05-host.css"), "utf8");

    expect(css).toMatch(
      /\[data-hnr-topbar-navigation\] \.pagetop \{[^}]*flex-wrap: wrap;[^}]*overflow-x: visible;[^}]*white-space: normal;/s,
    );
    expect(css).toContain(':is([op="reply"], [op="submit"])');
    expect(css).toMatch(
      /#hnmain form :is\(input\[type="text"\], input:not\(\[type\]\), textarea\) \{[^}]*width: 100% !important;[^}]*min-width: 0;/s,
    );
  });

  it("installs the host skin before the HN body is available", () => {
    document.documentElement.innerHTML = "<head></head><body></body>";
    const scope = new LifecycleScope();
    installHnHostAppearance(
      document,
      { kind: "list" },
      ".early-host-skin { display: grid; }",
      scope,
    );

    expect(document.documentElement.classList.contains("hnr-host-enhanced")).toBe(true);
    expect(document.documentElement.classList.contains("hnr-host-list")).toBe(true);
    expect(document.documentElement.classList.contains("hnr-host-ready")).toBe(false);
    expect(document.querySelector("[data-hnr-host-style]")?.textContent).toContain("early-host-skin");

    scope.destroy();
    expect(document.documentElement.classList.contains("hnr-host-enhanced")).toBe(false);
    expect(document.documentElement.classList.contains("hnr-host-ready")).toBe(false);
    expect(document.querySelector("[data-hnr-host-style]")).toBeNull();
  });

  it("restores the complete topbar tabs on a sparse native submit page", () => {
    history.replaceState({}, "", `${location.origin}/submit`);
    document.documentElement.innerHTML = `
      <head><base href="https://news.ycombinator.com/"></head><body><center>
        <table id="hnmain"><tbody>
          <tr><td><table><tbody><tr>
            <td><a href="news"><img src="y18.svg" alt="Y"></a></td>
            <td><span class="pagetop"><b>Submit</b></span></td>
            <td><span class="pagetop"><a href="user?id=tester">tester</a> | <a href="logout">logout</a></span></td>
          </tr></tbody></table></td></tr>
          <tr><td><form action="r"><input name="title"></form></td></tr>
        </tbody></table>
      </center></body>`;
    const scope = new LifecycleScope();
    const host = new HnHostController(document, { kind: "other" }, vi.fn(), "", scope);

    host.install();

    expect([...document.querySelectorAll<HTMLAnchorElement>("[data-hnr-topbar-navigation] a")]
      .map((anchor) => anchor.textContent)).toEqual([
      "welcome", "new", "threads", "past", "comments", "ask", "show", "jobs", "submit",
    ]);
    expect(document.querySelector<HTMLAnchorElement>('a[href*="threads?id=tester"]')).not.toBeNull();
    expect(document.querySelector('[data-hnr-topbar-active="true"]')?.textContent).toBe("submit");

    scope.destroy();
    expect(document.querySelector(".pagetop")?.textContent).toBe("Submit");
    history.replaceState({}, "", `${location.origin}/`);
  });

  it("turns list rows into reversible cards with Reader-first title clicks", async () => {
    document.documentElement.innerHTML = `
      <head><base href="https://news.ycombinator.com/"></head>
      <body><center><table id="hnmain"><tbody>
        <tr><td bgcolor="#ff6600"><table><tbody><tr>
          <td><a href="news"><img src="y18.svg" alt="Y"></a></td>
          <td><span class="pagetop"><b class="hnname"><a href="news">Hacker News</a></b><a href="newest">new</a></span></td>
          <td><span class="pagetop"><a id="me" href="user?id=tester">tester</a> | <a href="logout">logout</a></span></td>
        </tr></tbody></table></td></tr>
        <tr><td><table class="itemlist"><tbody>
          <tr class="athing" id="42"><td class="title"><span class="rank">1.</span></td><td class="votelinks"><a href="vote?id=42">vote</a></td><td class="title"><span class="titleline"><a href="https://example.com/article">Story</a></span></td></tr>
          <tr><td></td><td class="subtext"><a class="hnuser" href="user?id=alice">alice</a> | <a class="comments" href="item?id=42">12 comments</a></td></tr>
        </tbody></table></td></tr>
      </tbody></table></center></body>`;
    const onOpen = vi.fn();
    const onTranslateTitles = vi.fn((
      _titles: readonly { readonly id: StoryId; readonly title: string }[],
      _signal: AbortSignal,
      onTranslation: (output: { readonly id: number; readonly text: string; readonly html: string; readonly complete: boolean }) => void,
    ) => {
      onTranslation({ id: 42, text: "故事译题", html: "故事译题", complete: true });
      return Promise.resolve();
    });
    const scope = new LifecycleScope();
    const host = new HnHostController(
      document,
      { kind: "list" },
      onOpen,
      ".host-rule { color: red; }",
      scope,
      null,
      onTranslateTitles,
    );
    host.install();

    expect(document.documentElement.classList.contains("hnr-host-enhanced")).toBe(true);
    expect(document.documentElement.classList.contains("hnr-host-list")).toBe(true);
    expect(document.documentElement.classList.contains("hnr-host-ready")).toBe(true);
    expect(document.querySelector("[data-hnr-topbar]")).not.toBeNull();
    expect(document.querySelector("[data-hnr-topbar-navigation]")).not.toBeNull();
    expect(document.querySelector("[data-hnr-topbar-account]")).not.toBeNull();
    const logoMark = document.querySelector<SVGElement>("[data-hnr-topbar-logo-mark]");
    const logoAnchor = logoMark?.closest<HTMLAnchorElement>("a");
    expect(logoMark?.textContent).toBe("HN");
    expect(logoMark?.getAttribute("aria-hidden")).toBe("true");
    expect(logoAnchor?.getAttribute("aria-label")).toBe("Hacker News");
    expect(logoAnchor?.querySelector("img")).toBeNull();
    expect(document.querySelector("[data-hnr-host-style]")?.textContent).toContain(".host-rule");
    await vi.waitFor(() => expect(onTranslateTitles).toHaveBeenCalledWith([
      { id: 42, title: "Story" },
    ], expect.any(AbortSignal), expect.any(Function)));
    expect(document.querySelector("[data-hnr-title-translation]")?.textContent).toBe("故事译题");
    expect(document.querySelector("[data-hnr-original]")).toBeNull();
    expect(document.querySelector("[data-hnr-translate-title]")).toBeNull();

    const card = document.querySelector<HTMLTableRowElement>('[data-hnr-card-open="42"]');
    const metadata = document.querySelector<HTMLTableRowElement>('[data-hnr-card-meta="42"]');
    expect(card?.tabIndex).toBe(0);
    expect(card?.getAttribute("aria-label")).toBe("Open comments: Story");
    host.setActiveStory(42 as never);
    expect(card?.dataset.hnrCardActive).toBe("true");
    expect(metadata?.dataset.hnrCardActive).toBe("true");
    host.setActiveStory(null);
    expect(card?.hasAttribute("data-hnr-card-active")).toBe(false);
    expect(metadata?.hasAttribute("data-hnr-card-active")).toBe(false);
    card?.querySelector<HTMLElement>("td.title:last-child")?.click();
    metadata?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onOpen).toHaveBeenNthCalledWith(1, 42);
    expect(onOpen).toHaveBeenNthCalledWith(2, 42);

    const modifiedClick = new MouseEvent("click", { bubbles: true, ctrlKey: true });
    card?.dispatchEvent(modifiedClick);
    expect(onOpen).toHaveBeenCalledTimes(2);

    const command = document.querySelector<HTMLButtonElement>('[data-hnr-link="42"]');
    expect(command?.tagName).toBe("BUTTON");
    expect(command?.hasAttribute("href")).toBe(false);
    command?.click();
    expect(onOpen).toHaveBeenCalledTimes(3);
    expect(onOpen).toHaveBeenLastCalledWith(42);

    const title = document.querySelector<HTMLAnchorElement>(".titleline > a");
    const titleTooltip = document.querySelector<HTMLElement>(".hnr-host-title-tooltip");
    expect(titleTooltip?.textContent).toBe("Ctrl + 🖱️左键：打开原文");
    expect(titleTooltip?.classList.contains("hnr-tooltip")).toBe(true);
    expect(titleTooltip?.getAttribute("role")).toBe("tooltip");
    expect(title?.getAttribute("aria-describedby")).toBe(titleTooltip?.id);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    title?.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(4);
    expect(onOpen).toHaveBeenLastCalledWith(42);
    expect(title?.target).toBe("_blank");
    expect(title?.rel).toBe("noopener noreferrer");

    const modifiedTitleClick = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    title?.dispatchEvent(modifiedTitleClick);
    expect(modifiedTitleClick.defaultPrevented).toBe(false);
    expect(onOpen).toHaveBeenCalledTimes(4);

    const comments = document.querySelector<HTMLAnchorElement>(".comments");
    comments?.addEventListener("click", (event) => event.preventDefault(), { once: true });
    comments?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    expect(onOpen).toHaveBeenCalledTimes(4);

    const keyboardOpen = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    card?.dispatchEvent(keyboardOpen);
    expect(keyboardOpen.defaultPrevented).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(5);
    expect(onOpen).toHaveBeenLastCalledWith(42);

    scope.destroy();
    expect(document.querySelector("[data-hnr-link]")).toBeNull();
    expect(document.querySelector("[data-hnr-title-translation]")).toBeNull();
    expect(document.querySelector("[data-hnr-host-style]")).toBeNull();
    expect(document.querySelector("[data-hnr-card-open]")).toBeNull();
    expect(document.querySelector("[data-hnr-topbar]")).toBeNull();
    expect(document.querySelector("[data-hnr-topbar-logo-mark]")).toBeNull();
    expect(logoAnchor?.getAttribute("aria-label")).toBeNull();
    expect(logoAnchor?.querySelector("img")?.getAttribute("alt")).toBe("Y");
    expect(document.documentElement.classList.contains("hnr-host-enhanced")).toBe(false);
    expect(document.documentElement.classList.contains("hnr-host-ready")).toBe(false);
    expect(card?.hasAttribute("tabindex")).toBe(false);
    expect(title?.hasAttribute("target")).toBe(false);
    expect(title?.hasAttribute("aria-describedby")).toBe(false);
    expect(titleTooltip?.isConnected).toBe(false);
  });

  it("offers the last active story beside the account while Reader is closed", () => {
    history.replaceState({}, "", `${location.origin}/news`);
    document.documentElement.innerHTML = `<head><base href="https://news.ycombinator.com/"></head><body><center>
      <table id="hnmain"><tbody>
        <tr><td><table><tbody><tr>
          <td><a href="news"><img src="y18.svg" alt="Y"></a></td>
          <td><span class="pagetop"><a href="newest">new</a></span></td>
          <td><span class="pagetop"><a href="user?id=tester">tester</a> | <a href="logout">logout</a></span></td>
        </tr></tbody></table></td></tr>
        <tr><td><table class="itemlist"><tbody>
          <tr class="athing" id="49326409"><td class="title"></td><td class="votelinks"></td><td class="title"><span class="titleline"><a href="https://example.com/story">Story</a></span></td></tr>
          <tr><td></td><td class="subtext">1 comment</td></tr>
        </tbody></table></td></tr>
      </tbody></table>
    </center></body>`;
    const onOpen = vi.fn();
    const scope = new LifecycleScope();
    const card = document.getElementById("49326409") as HTMLTableRowElement;
    const scrollIntoView = vi.fn();
    card.scrollIntoView = scrollIntoView;
    const host = new HnHostController(document, { kind: "list" }, onOpen, "", scope, 49326409 as never);

    host.install();

    const resume = document.querySelector<HTMLButtonElement>("[data-hnr-resume-reader]");
    expect(resume?.hidden).toBe(false);
    expect(resume?.hasAttribute("title")).toBe(false);
    expect(resume?.previousSibling).toBeNull();
    expect(resume?.nextSibling?.textContent).toBe(" | ");
    expect(resume?.querySelector("[data-hnr-resume-reader-icon]")).not.toBeNull();
    const resumeTooltip = resume?.querySelector<HTMLElement>(".hnr-host-resume-tooltip");
    expect(resumeTooltip?.textContent).toBe("打开上次阅读的 Topic");
    expect(resumeTooltip?.classList.contains("hnr-tooltip")).toBe(true);
    expect(resumeTooltip?.getAttribute("role")).toBe("tooltip");
    expect(resume?.getAttribute("aria-describedby")).toBe(resumeTooltip?.id);
    expect(onOpen).not.toHaveBeenCalled();

    resume?.click();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "nearest" });
    expect(onOpen).toHaveBeenCalledWith(49326409);
    host.setActiveStory(49326409 as never);
    expect(resume?.hidden).toBe(true);
    expect(card.dataset.hnrCardActive).toBe("true");

    host.setActiveStory(null);
    expect(resume?.hidden).toBe(false);
    expect(card.hasAttribute("data-hnr-card-active")).toBe(false);
    host.setLastReadStory(null);
    expect(resume?.hidden).toBe(true);
    host.setLastReadStory(49326409 as never);
    expect(resume?.hidden).toBe(false);
    scope.destroy();
    expect(document.querySelector("[data-hnr-resume-reader]")).toBeNull();
  });

  it("projects and translates new comments as reversible Reader cards", async () => {
    document.documentElement.innerHTML = `<head><base href="https://news.ycombinator.com/newcomments"></head><body>
      <center><table id="hnmain"><tbody>
        <tr><td><table><tbody><tr><td></td><td><span class="pagetop"><a href="newcomments">comments</a></span></td><td></td></tr></tbody></table></td></tr>
        <tr id="bigbox"><td><table><tbody>
          <tr class="athing" id="49327487">
            <td class="ind"></td><td class="votelinks"><a href="vote?id=49327487">vote</a></td>
            <td class="default"><div><span class="comhead"><a class="hnuser" href="user?id=alice">alice</a> | <a href="item?id=49327487">0 minutes ago</a><span class="navs"> | <a href="item?id=456">parent</a> | <a href="item?id=777#49327487">context</a></span><span class="onstory"> | on: <a href="item?id=777">Story</a></span></span></div><br>
              <div class="comment"><div class="commtext c00">Original <code>npm test</code>. <a href="https://example.com/docs">Docs</a></div><div class="reply"></div></div>
            </td>
          </tr>
          <tr class="spacer" style="height:15px"></tr>
        </tbody></table></td></tr>
      </tbody></table></center>
    </body>`;
    const onOpen = vi.fn();
    let publishTranslation: (() => void) | undefined;
    const onTranslateComments = vi.fn((
      _comments: readonly { readonly id: number; readonly html: string }[],
      _signal: AbortSignal,
      onTranslation: (output: { readonly id: number; readonly text: string; readonly html: string; readonly complete: boolean }) => void,
    ) => {
      return new Promise<void>((resolve) => {
        publishTranslation = () => {
          onTranslation({ id: 49327487, text: "流式译文 npm test。", html: "流式译文 npm test。", complete: true });
          resolve();
        };
      });
    });
    const scope = new LifecycleScope();
    const host = new HnHostController(
      document,
      { kind: "comments" },
      onOpen,
      "",
      scope,
      null,
      undefined,
      onTranslateComments,
    );

    host.install();

    await vi.waitFor(() => expect(onTranslateComments).toHaveBeenCalledWith(
      [{
        id: 49327487,
        html: 'Original <code>npm test</code>. <a href="https://example.com/docs">Docs</a>',
      }],
      expect.any(AbortSignal),
      expect.any(Function),
    ));
    expect(document.documentElement.classList.contains("hnr-host-comments")).toBe(true);
    expect(document.querySelector("table.hnr-comment-list")).not.toBeNull();
    const card = document.querySelector<HTMLTableRowElement>('[data-hnr-comment-card="49327487"]');
    expect(card?.dataset.hnrCommentStory).toBe("777");
    expect(card?.tabIndex).toBe(0);
    expect(document.querySelector('[data-hnr-comment-card-spacer="49327487"]')).not.toBeNull();
    const pendingTranslation = document.querySelector('[data-hnr-comment-translation="49327487"]');
    expect(pendingTranslation?.querySelector('.hnr-translation-section.is-loading')).not.toBeNull();
    expect(pendingTranslation?.querySelectorAll('.hnr-translation-placeholder > span')).toHaveLength(3);

    publishTranslation?.();
    await vi.waitFor(() => expect(document.querySelector('[data-hnr-comment-translation="49327487"]')?.textContent)
      .toBe("流式译文 npm test。"));

    const parent = document.querySelector<HTMLAnchorElement>('.navs a[href="item?id=456"]');
    const parentClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    parent?.dispatchEvent(parentClick);
    expect(parentClick.defaultPrevented).toBe(true);
    expect(onOpen).toHaveBeenLastCalledWith(777, 49327487);

    const body = document.querySelector<HTMLElement>(".commtext");
    body?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onOpen).toHaveBeenLastCalledWith(777, 49327487);
    expect(onOpen).toHaveBeenCalledTimes(2);

    const external = document.querySelector<HTMLAnchorElement>('.commtext a[href="https://example.com/docs"]');
    external?.addEventListener("click", (event) => event.preventDefault(), { once: true });
    external?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onOpen).toHaveBeenCalledTimes(2);

    const user = document.querySelector<HTMLAnchorElement>('.hnuser[href="user?id=alice"]');
    user?.addEventListener("click", (event) => event.preventDefault(), { once: true });
    user?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onOpen).toHaveBeenCalledTimes(2);

    const keyboardOpen = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    card?.dispatchEvent(keyboardOpen);
    expect(keyboardOpen.defaultPrevented).toBe(true);
    expect(onOpen).toHaveBeenLastCalledWith(777, 49327487);
    expect(onOpen).toHaveBeenCalledTimes(3);

    scope.destroy();
    expect(document.documentElement.classList.contains("hnr-host-comments")).toBe(false);
    expect(document.querySelector("table.hnr-comment-list")).toBeNull();
    expect(document.querySelector("[data-hnr-comment-card]")).toBeNull();
    expect(document.querySelector("[data-hnr-comment-translation]")).toBeNull();
    expect(card?.hasAttribute("tabindex")).toBe(false);
  });

  it("appends a detached More page as reversible Reader cards", () => {
    document.documentElement.innerHTML = `<head><base href="https://news.ycombinator.com/front"></head><body>
      <table class="itemlist"><tbody>
        <tr class="athing" id="42"><td class="title"></td><td class="votelinks"></td><td class="title"><span class="titleline"><a href="https://example.com/one">One</a></span></td></tr>
        <tr><td></td><td class="subtext">1 comment</td></tr>
        <tr><td><a class="morelink" href="front?p=2">More</a></td></tr>
      </tbody></table>
      <footer id="native-footer">Guidelines · FAQ</footer>
    </body>`;
    const onOpen = vi.fn();
    const scope = new LifecycleScope();
    const host = new HnHostController(document, { kind: "list" }, onOpen, "", scope);
    host.install();
    host.setActiveStory(43 as never);
    const page = new DOMParser().parseFromString(`<html><head><base href="https://news.ycombinator.com/front?p=2"></head><body>
      <table class="itemlist"><tbody>
        <tr class="athing" id="43"><td class="title"></td><td class="votelinks"></td><td class="title"><span class="titleline"><a href="https://example.com/two">Two</a></span></td></tr>
        <tr><td></td><td class="subtext">2 comments</td></tr>
        <tr class="spacer"><td></td></tr>
        <tr><td><a class="morelink" href="front?p=3">More</a></td></tr>
      </tbody></table>
    </body></html>`, "text/html");

    expect(host.nextPageUrl()).toBe("https://news.ycombinator.com/front?p=2");
    expect(host.appendListPage(page)).toBe(1);
    expect(host.nextPageUrl()).toBe("https://news.ycombinator.com/front?p=3");
    expect(document.querySelector("table.itemlist")?.nextElementSibling?.id).toBe("native-footer");
    expect(document.querySelectorAll("#native-footer")).toHaveLength(1);
    const appended = document.querySelector<HTMLTableRowElement>('[data-hnr-card-open="43"]');
    expect(appended?.tabIndex).toBe(0);
    expect(appended?.dataset.hnrCardActive).toBe("true");
    expect(document.querySelector<HTMLElement>('[data-hnr-card-meta="43"]')?.dataset.hnrCardActive).toBe("true");
    expect(document.querySelector('[data-hnr-link="43"]')).not.toBeNull();
    appended?.querySelector<HTMLElement>("td.title:last-child")?.click();
    expect(onOpen).toHaveBeenCalledWith(43);

    scope.destroy();
    expect(document.getElementById("43")).toBeNull();
    expect(document.querySelector<HTMLAnchorElement>("a.morelink")?.href).toBe("https://news.ycombinator.com/front?p=2");
  });

  it("leaves item-route startup to the bootstrap Reader owner", async () => {
    history.replaceState({}, "", `${location.origin}/item?id=100#hn-reader`);
    document.documentElement.innerHTML = "<head></head><body><table><tr class='athing' id='100'></tr><tr><td class='subtext'></td></tr></table></body>";
    const onOpen = vi.fn();
    const scope = new LifecycleScope();
    const host = new HnHostController(document, { kind: "item", itemId: 100 }, onOpen, "", scope, 42 as never);

    host.install();
    await Promise.resolve();

    expect(onOpen).not.toHaveBeenCalled();
    scope.destroy();
    history.replaceState({}, "", `${location.origin}/news`);
  });
});
