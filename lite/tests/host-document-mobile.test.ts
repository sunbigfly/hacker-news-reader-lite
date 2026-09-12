// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { HnHostController } from "../src/host/hn-host-controller";
import { parseHnRoute } from "../src/host/hn-route";
import { LifecycleScope } from "../src/kernel/lifecycle";

const scopes: LifecycleScope[] = [];
const shell = (content: string): string => `<table id="hnmain" width="85%"><tr><td><table width="100%"><tr><td><a href="news"><img src="y18.svg" width="18" height="18"></a></td><td><span class="pagetop"><a href="news">news</a></span></td><td><span class="pagetop"><a href="login">login</a></span></td></tr></table></td></tr><tr><td>${content}</td></tr></table>`;
const copy = '<table width="500" bgcolor="#f6f6ef"><tr><td><img src="yc500.gif" width="500"><p><b>Welcome</b></p><p>Readable information with a <a href="newsguidelines.html">guidelines link</a>.</p></td></tr></table>';

function install(path: string, body: string, head = ""): { host: HnHostController; scope: LifecycleScope } {
  history.replaceState({}, "", `${location.origin}${path}`);
  document.documentElement.innerHTML = `<head>${head}</head><body>${body}</body>`;
  const scope = new LifecycleScope();
  scopes.push(scope);
  const host = new HnHostController(document, parseHnRoute(location), vi.fn(), "", scope);
  host.install();
  return { host, scope };
}

afterEach(() => {
  for (const scope of scopes.splice(0)) scope.destroy();
  history.replaceState({}, "", `${location.origin}/news`);
});

describe("mobile host documents", () => {
  it.each(["/newswelcome.html", "/newsfaq.html", "/newsguidelines.html", "/formatdoc"])("adapts direct entry to %s and restores the original DOM on teardown", (path) => {
    const { scope } = install(path, path === "/formatdoc" ? shell(copy) : `<center>${copy}</center>`);
    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    expect(viewport?.content).toBe("width=device-width, initial-scale=1");
    expect(viewport?.content).not.toContain("user-scalable");
    const content = path === "/formatdoc" ? document.querySelector('#hnmain table[width="500"]') : document.querySelector(".hnr-host-standalone");
    expect(content?.classList.contains("hnr-host-document")).toBe(true);
    expect(content?.textContent).toContain("Readable information");
    expect(document.querySelector('a[href="newsguidelines.html"]')).not.toBeNull();
    expect(document.querySelector("[data-hnr-topbar]")).not.toBeNull();
    expect(document.querySelector('[data-hnr-topbar-navigation] a[href="newswelcome.html"]')).not.toBeNull();
    expect(document.querySelector('[data-hnr-topbar]')?.classList.contains("hnr-host-document") ?? false).toBe(false);
    scope.destroy();
    expect(document.querySelector('meta[name="viewport"]')).toBeNull();
    expect(document.querySelector(".hnr-host-document")).toBeNull();
    expect(document.querySelector('img[width="500"]')).not.toBeNull();
    if (path !== "/formatdoc") expect(document.getElementById("hnmain")).toBeNull();
  });

  it("preserves an existing viewport and does not duplicate it when projection refreshes", () => {
    const content = "width=device-width, initial-scale=0.8, maximum-scale=4";
    const { host, scope } = install("/newswelcome.html", `<center>${copy}</center>`, `<meta name="viewport" content="${content}">`);
    host.refreshPageProjection();
    expect(document.querySelectorAll('meta[name="viewport"]')).toHaveLength(1);
    expect(document.querySelector<HTMLMetaElement>('meta[name="viewport"]')?.content).toBe(content);
    scope.destroy();
    expect(document.querySelector<HTMLMetaElement>('meta[name="viewport"]')?.content).toBe(content);
  });

  it("uses the same document styling after navigation and releases it when returning to the list", () => {
    const { host } = install("/news", shell("<p>Stories</p>"));
    const main = document.querySelector("#hnmain");
    const welcome = new DOMParser().parseFromString(`<body><center>${copy}</center></body>`, "text/html");
    expect(host.replaceHostPage(welcome, "https://news.ycombinator.com/newswelcome.html")).toBe(true);
    expect(document.querySelector("#hnmain")).toBe(main);
    expect(document.querySelector(".hnr-host-standalone.hnr-host-document")).not.toBeNull();
    expect(document.documentElement.classList.contains("hnr-host-native-page")).toBe(true);
    const news = new DOMParser().parseFromString(`<body>${shell("<p>New stories</p>")}</body>`, "text/html");
    expect(host.replaceHostPage(news, "https://news.ycombinator.com/news")).toBe(true);
    expect(document.querySelector(".hnr-host-document")).toBeNull();
    expect(document.documentElement.classList.contains("hnr-host-native-page")).toBe(false);
    expect(document.querySelector("#hnmain")).toBe(main);
  });

  it("retains the generated frozen header when a direct welcome entry navigates to guidelines", () => {
    const { host } = install("/newswelcome.html", `<center>${copy}</center>`);
    const topbar = document.querySelector("[data-hnr-topbar]");
    const incoming = new DOMParser().parseFromString(`<body><center>${copy}</center></body>`, "text/html");
    expect(host.replaceHostPage(incoming, "https://news.ycombinator.com/newsguidelines.html")).toBe(true);
    expect(document.querySelector("[data-hnr-topbar]")).toBe(topbar);
    expect(document.querySelector(".hnr-host-standalone.hnr-host-document")).not.toBeNull();
    expect(document.querySelectorAll("#hnmain")).toHaveLength(1);
  });

  it.each(["/login", "/reply", "/submit", "/user?id=sample"])("keeps native form actions and values intact on %s", (path) => {
    const formHtml = '<form method="post" action="/native-action"><table width="500"><tr><td>Text</td><td><input name="title" size="80" value="Draft"><textarea name="text" cols="80">Reply draft</textarea><button type="submit">Send</button></td></tr></table></form>';
    const { host } = install(path, path === "/login" ? formHtml : shell(formHtml));
    const form = document.querySelector("form");
    expect(form).not.toBeNull();
    host.refreshPageProjection();
    expect(document.querySelector("form")).toBe(form);
    expect(form?.getAttribute("action")).toBe("/native-action");
    expect(form?.method).toBe("post");
    expect(form?.querySelector("input")?.value).toBe("Draft");
    expect(form?.querySelector("textarea")?.value).toBe("Reply draft");
    expect(document.documentElement.classList.contains("hnr-host-native-page")).toBe(true);
    expect(document.querySelector(".hnr-host-document")).toBeNull();
  });
});
