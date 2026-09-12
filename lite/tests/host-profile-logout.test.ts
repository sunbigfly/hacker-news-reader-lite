// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { HnHostController } from "../src/host/hn-host-controller";
import { parseHnRoute } from "../src/host/hn-route";
import { LifecycleScope } from "../src/kernel/lifecycle";

const scopes: LifecycleScope[] = [];
const nativeAccount = '<a href="user?id=sample">sample</a> (1) | <a href="logout?auth=fixture">logout</a>';
function mount(path: string, accountMarkup = nativeAccount): { host: HnHostController; scope: LifecycleScope } {
  history.replaceState({}, "", `${location.origin}${path}`);
  document.documentElement.innerHTML = `<head></head><body><center><table id="hnmain"><tr><td><table><tr><td><a href="news"><img src="y18.svg"></a></td><td><span class="pagetop"><a href="news">news</a></span></td><td><span class="pagetop">${accountMarkup}</span></td></tr></table></td></tr><tr><td><form method="post" action="user"><table><tr><td>karma:</td><td data-profile-karma>1</td></tr></table><textarea name="about">Draft</textarea><input type="submit" value="update"></form></td></tr></table></center></body>`;
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

describe("profile logout placement", () => {
  it.each([
    '<a href="user?id=sample">sample</a> (<span id="karma">1</span>) | <a href="logout?auth=fixture">logout</a>',
    '<b><a href="user?id=sample">sample</a></b> <span>(<span id="karma">1,234</span>)</span> | <a href="logout?auth=fixture">logout</a>',
  ])("hides karma across nested nodes and restores the native account markup: %s", (accountMarkup) => {
    const { host, scope } = mount("/user?id=sample", accountMarkup);
    const account = document.querySelector("[data-hnr-topbar-account] .pagetop");
    const profile = account?.querySelector('a[href="user?id=sample"]');
    const karma = account?.querySelector("#karma");
    const onProfileClick = vi.fn((event: Event) => event.preventDefault());
    profile?.addEventListener("click", onProfileClick);
    expect(account?.textContent).not.toMatch(/[()\d]/u);
    expect(document.querySelector("[data-profile-karma]")?.textContent).toBe("1");
    host.refreshPageProjection();
    expect(account?.textContent).not.toMatch(/[()\d]/u);
    expect(account?.querySelector('a[href="user?id=sample"]')).toBe(profile);
    expect(account?.querySelector("#karma")).toBe(karma);
    profile?.dispatchEvent(new MouseEvent("click", { cancelable: true }));
    expect(onProfileClick).toHaveBeenCalledOnce();
    expect(document.querySelectorAll(".hnr-host-profile-session")).toHaveLength(1);
    expect(document.querySelector(".hnr-host-profile-session a")?.getAttribute("href")).toBe("logout?auth=fixture");
    scope.destroy();
    expect(account?.innerHTML).toBe(accountMarkup);
  });

  it("hides the header logout and its separator while retaining the native account link", () => {
    const { scope } = mount("/news");
    const logout = document.querySelector('[data-hnr-topbar-account] a[href^="logout"]');
    expect(logout?.getAttribute("data-hnr-logout-hidden")).toBe("true");
    expect(logout?.previousSibling?.textContent).toBe("");
    expect(document.querySelector('[data-hnr-topbar-account] a[href="user?id=sample"]')).not.toBeNull();
    expect(document.querySelector(".hnr-host-profile-session")).toBeNull();
    scope.destroy();
    expect(logout?.hasAttribute("data-hnr-logout-hidden")).toBe(false);
    expect(logout?.previousSibling?.textContent).toBe(" (1) | ");
  });

  it("places the exact native logout link after the owner's form and keeps refreshes idempotent", () => {
    const { host, scope } = mount("/user?id=sample");
    const action = document.querySelector<HTMLAnchorElement>(".hnr-host-profile-session a");
    expect(action?.getAttribute("href")).toBe("logout?auth=fixture");
    expect(action?.textContent).toBe("退出登录");
    expect(action?.closest("form")).toBeNull();
    expect(document.querySelector("form")?.nextElementSibling?.className).toBe("hnr-host-profile-session");
    host.refreshPageProjection();
    expect(document.querySelectorAll(".hnr-host-profile-session")).toHaveLength(1);
    expect(document.querySelector("textarea")?.value).toBe("Draft");
    expect(document.querySelector("form")?.getAttribute("action")).toBe("user");
    scope.destroy();
    expect(document.querySelector(".hnr-host-profile-session")).toBeNull();
    expect(document.querySelector('a[href="logout?auth=fixture"]')).not.toBeNull();
  });

  it("does not add a logout action to somebody else's profile", () => {
    mount("/user?id=another");
    expect(document.querySelector(".hnr-host-profile-session")).toBeNull();
    expect(document.querySelector('[data-hnr-topbar-account] [data-hnr-logout-hidden]')).not.toBeNull();
  });
});
