import { describe, expect, it, vi } from "vitest";
import { RequestScheduler } from "../src/network/request-scheduler";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe("RequestScheduler", () => {
  it("bounds concurrency and prioritizes interactive queued work", async () => {
    const scheduler = new RequestScheduler(1);
    const first = deferred<string>();
    const order: string[] = [];
    const p1 = scheduler.schedule({
      key: "first",
      lane: "hn-supplement",
      run: async () => { order.push("first"); return first.promise; },
    });
    await Promise.resolve();
    const p2 = scheduler.schedule({
      key: "background",
      lane: "hn-supplement",
      run: () => { order.push("background"); return Promise.resolve("background"); },
    });
    const p3 = scheduler.schedule({
      key: "interactive",
      lane: "hn-interactive",
      run: () => { order.push("interactive"); return Promise.resolve("interactive"); },
    });
    await Promise.resolve();
    expect(scheduler.activeCount).toBe(1);
    first.resolve("first");
    await expect(Promise.all([p1, p2, p3])).resolves.toEqual(["first", "background", "interactive"]);
    expect(order).toEqual(["first", "interactive", "background"]);
  });

  it("deduplicates by key and cancels when every subscriber leaves", async () => {
    const scheduler = new RequestScheduler(2);
    const run = vi.fn((signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason instanceof Error ? signal.reason : new Error("cancelled")), { once: true });
    }));
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = scheduler.schedule({ key: "same", lane: "article", signal: firstController.signal, run });
    const second = scheduler.schedule({ key: "same", lane: "article", signal: secondController.signal, run });
    await Promise.resolve();
    firstController.abort(new Error("first left"));
    await expect(first).rejects.toThrow("first left");
    expect(run).toHaveBeenCalledOnce();
    secondController.abort(new Error("second left"));
    await expect(second).rejects.toThrow("second left");
    await scheduler.whenIdle();
    expect(scheduler.size).toBe(0);
  });

  it("starts a fresh same-key request instead of reusing an aborting entry", async () => {
    const scheduler = new RequestScheduler(1);
    const firstController = new AbortController();
    const firstRun = vi.fn(() => new Promise<string>(() => undefined));
    const first = scheduler.schedule({
      key: "same-tab",
      lane: "hn-interactive",
      signal: firstController.signal,
      run: firstRun,
    });
    await Promise.resolve();
    expect(firstRun).toHaveBeenCalledOnce();

    firstController.abort(new Error("navigation replaced"));
    const secondRun = vi.fn(() => Promise.resolve("fresh page"));
    const second = scheduler.schedule({
      key: "same-tab",
      lane: "hn-interactive",
      run: secondRun,
    });

    await expect(first).rejects.toThrow("navigation replaced");
    await expect(second).resolves.toBe("fresh page");
    expect(secondRun).toHaveBeenCalledOnce();
    await scheduler.whenIdle();
    expect(scheduler.size).toBe(0);
    scheduler.destroy();
  });
});
