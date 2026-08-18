import { describe, expect, it, vi } from "vitest";
import { LifecycleScope } from "../src/kernel/lifecycle";
import { RepeatActionGate } from "../src/kernel/repeat-action-gate";
import { Signal } from "../src/kernel/signal";

describe("LifecycleScope", () => {
  it("cleans children and listeners in reverse order exactly once", () => {
    const target = new EventTarget();
    const scope = new LifecycleScope();
    const order: string[] = [];
    let calls = 0;
    scope.add(() => order.push("first"));
    scope.listen(target, "change", () => calls += 1);
    const child = scope.child();
    child.add(() => order.push("child"));
    scope.add(() => order.push("last"));
    target.dispatchEvent(new Event("change"));
    scope.destroy();
    scope.destroy();
    target.dispatchEvent(new Event("change"));
    expect(calls).toBe(1);
    expect(order).toEqual(["last", "child", "first"]);
  });

  it("runs late cleanup and aborts owned work", () => {
    const scope = new LifecycleScope();
    scope.destroy();
    const cleanup = vi.fn();
    scope.add(cleanup);
    const reason = new Error("retired");
    const controller = scope.abortController(reason);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe(reason);
  });
});

describe("Signal", () => {
  it("isolates listener failures and unsubscribes with scope", () => {
    const signal = new Signal<number>();
    const scope = new LifecycleScope();
    const values: number[] = [];
    signal.subscribe((value) => values.push(value), scope);
    signal.subscribe(() => { throw new Error("isolated"); });
    expect(signal.emit(3)).toHaveLength(1);
    scope.destroy();
    signal.emit(4);
    expect(values).toEqual([3]);
  });
});

describe("RepeatActionGate", () => {
  it("requires a bounded same-key confirmation", () => {
    let now = 1_000;
    const gate = new RepeatActionGate({ windowMs: 100, now: () => now });
    expect(gate.confirm("reader:close")).toBe(false);
    expect(gate.confirm("reader:close")).toBe(true);
    expect(gate.confirm("reader:close")).toBe(false);
    expect(gate.confirm("settings:reset")).toBe(false);
    now += 101;
    expect(gate.confirm("settings:reset")).toBe(false);
  });
});
