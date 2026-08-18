// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HN_HTML_MAX_CONCURRENT,
  teardownHnHostForPageTransition,
} from "../src/app/bootstrap";
import { LifecycleScope } from "../src/kernel/lifecycle";
import { RequestScheduler } from "../src/network/request-scheduler";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

afterEach(() => {
  document.documentElement.style.removeProperty("visibility");
});

describe("bootstrap page transition", () => {
  it("lets a cold host tab start while the restored Reader is refreshing", async () => {
    const scheduler = new RequestScheduler(HN_HTML_MAX_CONCURRENT);
    const readerRefresh = deferred<string>();
    const tabStarted = vi.fn();
    const readerRequest = scheduler.schedule({
      key: "hn-page:reader",
      lane: "hn-interactive",
      run: () => readerRefresh.promise,
    });
    await Promise.resolve();

    const tabRequest = scheduler.schedule({
      key: "hn-host-page:comments",
      lane: "hn-interactive",
      run: () => {
        tabStarted();
        return Promise.resolve("comments");
      },
    });
    await Promise.resolve();

    expect(HN_HTML_MAX_CONCURRENT).toBe(2);
    expect(tabStarted).toHaveBeenCalledOnce();
    await expect(tabRequest).resolves.toBe("comments");
    readerRefresh.resolve("reader");
    await expect(readerRequest).resolves.toBe("reader");
    scheduler.destroy();
  });

  it("cloaks a leaving document before reversible host cleanup", () => {
    const scope = new LifecycleScope();
    const event = new Event("pagehide");

    teardownHnHostForPageTransition(document, scope, event);

    expect(scope.destroyed).toBe(true);
    expect(document.documentElement.style.getPropertyValue("visibility")).toBe("hidden");
  });

  it("keeps a back-forward cached host mounted", () => {
    const scope = new LifecycleScope();
    const event = new Event("pagehide");
    Object.defineProperty(event, "persisted", { value: true });

    teardownHnHostForPageTransition(document, scope, event);

    expect(scope.destroyed).toBe(false);
    expect(document.documentElement.style.getPropertyValue("visibility")).toBe("");
    scope.destroy();
  });
});
