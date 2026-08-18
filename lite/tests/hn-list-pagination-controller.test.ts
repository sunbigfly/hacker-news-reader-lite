// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  HnListPaginationController,
  type HnListPageLoader,
  type HnListPaginationHost,
} from "../src/host/hn-list-pagination-controller";
import { LifecycleScope } from "../src/kernel/lifecycle";

function placeNearDocumentBottom(): void {
  Object.defineProperties(document.documentElement, {
    scrollHeight: { configurable: true, value: 2_000 },
    clientHeight: { configurable: true, value: 800 },
    scrollTop: { configurable: true, value: 1_000, writable: true },
  });
}

describe("HnListPaginationController", () => {
  it("waits for host scrolling, then loads and appends the More page once", async () => {
    document.documentElement.innerHTML = `<head><base href="https://news.ycombinator.com/front"></head><body>
      <center><table class="itemlist"><tbody><tr><td><a class="morelink" href="front?p=2">More</a></td></tr></tbody></table></center>
    </body>`;
    placeNearDocumentBottom();
    const nextUrl = "https://news.ycombinator.com/front?p=2";
    const page = document.implementation.createHTMLDocument("next");
    const load = vi.fn(() => Promise.resolve({ document: page, finalUrl: nextUrl }));
    const appendListPage = vi.fn(() => 30);
    const loader: HnListPageLoader = { load };
    const host: HnListPaginationHost = {
      nextPageUrl: () => nextUrl,
      appendListPage,
    };
    const scope = new LifecycleScope();
    const controller = new HnListPaginationController(document, loader, host, scope);
    controller.install();

    await Promise.resolve();
    expect(load).not.toHaveBeenCalled();
    window.dispatchEvent(new Event("scroll"));

    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    expect(load).toHaveBeenCalledWith(
      "https://news.ycombinator.com/front?p=2",
      expect.any(AbortSignal),
    );
    await vi.waitFor(() => expect(appendListPage).toHaveBeenCalledWith(page));
    window.dispatchEvent(new Event("scroll"));
    await Promise.resolve();
    expect(load).toHaveBeenCalledOnce();
    scope.destroy();
  });

  it("retries one failed automatic request, then preserves the native More link", async () => {
    document.documentElement.innerHTML = `<head><base href="https://news.ycombinator.com/front"></head><body>
      <center><table class="itemlist"><tbody><tr><td><a class="morelink" href="front?p=2">More</a></td></tr></tbody></table></center>
    </body>`;
    placeNearDocumentBottom();
    const load = vi.fn(() => Promise.reject(new Error("network unavailable")));
    const appendListPage = vi.fn(() => 0);
    const loader: HnListPageLoader = { load };
    const host: HnListPaginationHost = {
      nextPageUrl: () => "https://news.ycombinator.com/front?p=2",
      appendListPage,
    };
    const scope = new LifecycleScope();
    const controller = new HnListPaginationController(document, loader, host, scope, Date.now, 10);
    controller.install();

    window.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(load).toHaveBeenCalled());
    const more = document.querySelector<HTMLAnchorElement>("a.morelink");
    expect(appendListPage).not.toHaveBeenCalled();

    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(load).toHaveBeenCalledTimes(2);
    expect(more?.textContent).toBe("More · 自动加载失败，点击继续");
    expect(more?.hasAttribute("data-hnr-loading")).toBe(false);
    expect(more?.hasAttribute("aria-busy")).toBe(false);
    scope.destroy();
  });

  it("captures the embedded host scroller after Reader opens", async () => {
    document.documentElement.innerHTML = `<head><base href="https://news.ycombinator.com/front"></head><body>
      <center><table class="itemlist"><tbody><tr><td><a class="morelink" href="front?p=2">More</a></td></tr></tbody></table></center>
    </body>`;
    document.documentElement.classList.add("hnr-reader-embedded-right");
    const center = document.querySelector<HTMLElement>("body > center");
    if (!center) throw new Error("embedded host scroller was not created");
    Object.defineProperties(center, {
      scrollHeight: { configurable: true, value: 2_000 },
      clientHeight: { configurable: true, value: 800 },
      scrollTop: { configurable: true, value: 1_000, writable: true },
    });
    const page = document.implementation.createHTMLDocument("next");
    const load = vi.fn(() => Promise.resolve({
      document: page,
      finalUrl: "https://news.ycombinator.com/front?p=2",
    }));
    const appendListPage = vi.fn(() => 30);
    const scope = new LifecycleScope();
    const controller = new HnListPaginationController(document, { load }, {
      nextPageUrl: () => "https://news.ycombinator.com/front?p=2",
      appendListPage,
    }, scope);
    controller.install();

    center.dispatchEvent(new Event("scroll"));

    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    expect(appendListPage).toHaveBeenCalledWith(page);
    scope.destroy();
    document.documentElement.classList.remove("hnr-reader-embedded-right");
  });

  it("allows the new host list to load an identical More URL after a tab replacement", async () => {
    document.documentElement.innerHTML = `<head><base href="https://news.ycombinator.com/front"></head><body>
      <center><table class="itemlist"><tbody><tr><td><a class="morelink" href="front?p=2">More</a></td></tr></tbody></table></center>
    </body>`;
    placeNearDocumentBottom();
    const page = document.implementation.createHTMLDocument("next");
    const load = vi.fn(() => Promise.resolve({
      document: page,
      finalUrl: "https://news.ycombinator.com/front?p=2",
    }));
    const appendListPage = vi.fn(() => 30);
    const scope = new LifecycleScope();
    const controller = new HnListPaginationController(document, { load }, {
      nextPageUrl: () => "https://news.ycombinator.com/front?p=2",
      appendListPage,
    }, scope);
    controller.install();

    window.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(appendListPage).toHaveBeenCalledOnce());

    controller.resetForListPage();
    window.dispatchEvent(new Event("scroll"));

    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    expect(appendListPage).toHaveBeenCalledTimes(2);
    scope.destroy();
  });

  it("aborts and pauses More while an interactive host navigation is in flight", async () => {
    document.documentElement.innerHTML = `<head><base href="https://news.ycombinator.com/front"></head><body>
      <center><table class="itemlist"><tbody><tr><td><a class="morelink" href="front?p=2">More</a></td></tr></tbody></table></center>
    </body>`;
    placeNearDocumentBottom();
    let requestSignal: AbortSignal | undefined;
    const load = vi.fn((_url: string, signal?: AbortSignal): Promise<never> => {
      requestSignal = signal;
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const scope = new LifecycleScope();
    const controller = new HnListPaginationController(document, { load }, {
      nextPageUrl: () => "https://news.ycombinator.com/front?p=2",
      appendListPage: vi.fn(() => 0),
    }, scope);
    controller.install();
    window.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());

    controller.suspendForHostNavigation();
    window.dispatchEvent(new Event("scroll"));
    await Promise.resolve();

    expect(requestSignal?.aborted).toBe(true);
    expect(load).toHaveBeenCalledOnce();
    controller.resetForListPage();
    scope.destroy();
  });

  it("aborts an in-flight page when the host lifecycle ends", async () => {
    document.documentElement.innerHTML = `<head><base href="https://news.ycombinator.com/front"></head><body>
      <center><table class="itemlist"><tbody><tr><td><a class="morelink" href="front?p=2">More</a></td></tr></tbody></table></center>
    </body>`;
    placeNearDocumentBottom();
    let requestSignal: AbortSignal | undefined;
    const load = vi.fn((_url: string, signal?: AbortSignal): Promise<never> => {
      requestSignal = signal;
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error("request aborted"));
        }, { once: true });
      });
    });
    const appendListPage = vi.fn(() => 0);
    const loader: HnListPageLoader = { load };
    const host: HnListPaginationHost = {
      nextPageUrl: () => "https://news.ycombinator.com/front?p=2",
      appendListPage,
    };
    const scope = new LifecycleScope();
    const controller = new HnListPaginationController(document, loader, host, scope);
    controller.install();
    window.dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(load).toHaveBeenCalledOnce());

    scope.destroy();

    expect(requestSignal?.aborted).toBe(true);
    expect(appendListPage).not.toHaveBeenCalled();
  });
});
