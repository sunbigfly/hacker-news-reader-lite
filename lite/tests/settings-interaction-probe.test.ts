// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { installSettingsInteractionProbe } from "../src/debug/settings-interaction-probe";

const probes: ReturnType<typeof installSettingsInteractionProbe>[] = [];
function install(): ReturnType<typeof installSettingsInteractionProbe> {
  const probe = installSettingsInteractionProbe(window);
  probes.push(probe);
  return probe;
}
afterEach(() => {
  for (const probe of probes.splice(0)) probe.destroy();
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); document.body.replaceChildren();
});

it("records event and focus metadata without exposing input contents and stops after 60 seconds", () => {
  vi.useFakeTimers();
  const host = document.createElement("div");
  host.id = "hn-reader-root";
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = '<form class="hnr-settings"><input type="password" value="private-form-value"><div class="pages"></div></form>';
  const input = root.querySelector("input");
  const pages = root.querySelector(".pages");
  if (!input || !pages) throw new Error("Missing fixture");
  const probe = install();
  const output = document.querySelector("#hnr-interaction-probe")?.shadowRoot?.querySelector("pre");
  vi.advanceTimersByTime(500);
  input.dispatchEvent(new Event("touchstart", { bubbles: true, composed: true }));
  input.click();
  input.focus();
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  pages.dispatchEvent(new Event("scroll"));
  vi.advanceTimersByTime(500);
  expect(output?.textContent).toContain("触摸=1");
  expect(output?.textContent).toContain("输入=1 滚动=1");
  expect(output?.textContent).toContain("活动=input/password");
  expect(output?.textContent).not.toContain("private-form-value");
  expect(probe.exportLog()).not.toContain("private-form-value");
  vi.advanceTimersByTime(59_000);
  vi.advanceTimersByTime(1); // Flush JSDOM's queued storage events.
  expect(output?.textContent).toContain("已停止");
  expect(vi.getTimerCount()).toBe(0);
  const final = output?.textContent;
  input.click();
  vi.advanceTimersByTime(1000);
  expect(output?.textContent).toBe(final);
  probe.destroy();
  expect(document.querySelector("#hnr-interaction-probe")).toBeNull();
});

it("clears sampling on navigation even when no reader was mounted", () => {
  vi.useFakeTimers();
  const probe = install();
  window.dispatchEvent(new Event("pagehide"));
  vi.advanceTimersByTime(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(probe.exportLog()).toContain('"stopReason": "pagehide"');
  probe.destroy();
});

it("exports a downloadable JSON file and offers a text fallback for clipboard-unavailable browsers", () => {
  vi.useFakeTimers();
  const createObjectURL = vi.fn(() => "blob:probe-log");
  const revokeObjectURL = vi.fn();
  vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
  const download = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toMatch(/^hnr-phone-log-\d+\.json$/);
  });
  const probe = install();
  const root = document.querySelector("#hnr-interaction-probe")?.shadowRoot;
  const buttons = [...root?.querySelectorAll("button") ?? []];
  buttons.find((button) => button.textContent === "导出")?.click();
  expect(download).toHaveBeenCalledOnce();
  expect(createObjectURL).toHaveBeenCalledOnce();
  buttons.find((button) => button.textContent === "复制")?.click();
  const text = root?.querySelector("textarea");
  expect(text?.hidden).toBe(false);
  expect(text?.readOnly).toBe(true);
  expect(text?.value).toBe(probe.exportLog());
  probe.destroy();
  vi.advanceTimersByTime(1);
  expect(revokeObjectURL).toHaveBeenCalledWith("blob:probe-log");
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps error classifications and locations without recording raw messages or rejection contents", () => {
  vi.useFakeTimers();
  const probe = install();
  window.dispatchEvent(new ErrorEvent("error", {
    error: new TypeError("private-form-value is not a function"), message: "private-form-value", lineno: 20, colno: 7,
  }));
  window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new RangeError("Maximum call stack size exceeded: private-form-value") }));
  const report = probe.exportLog();
  expect(report).toContain('"category": "missing-function"');
  expect(report).toContain('"category": "recursion"');
  expect(report).toContain('"line": 20');
  expect(report).not.toContain("private-form-value");
  probe.destroy();
});

it("records known API names from errors without an Error object without leaking the message", () => {
  const probe = install();
  window.dispatchEvent(new ErrorEvent("error", {
    message: "GM_xmlhttpRequest is not a function: private-form-value", lineno: 5, colno: 68,
  }));
  const report = probe.exportLog();
  expect(report).toContain('"api": "GM_xmlhttpRequest"');
  expect(report).toContain('"category": "missing-function"');
  expect(report).not.toContain("private-form-value");
});

it("records slow reader call owners and ignores payload contents and events after stopping", () => {
  const probe = install();
  const detail = { owner: "gm-http-client:GM_xmlhttpRequest", phase: "end", durationMs: 10000, failed: false, body: "private-body" };
  document.dispatchEvent(new CustomEvent("hnr:probe-call", { detail }));
  expect(probe.exportLog()).toContain('"type": "reader-call"');
  expect(probe.exportLog()).toContain('"durationMs": 10000');
  expect(probe.exportLog()).not.toContain("private-body");
  probe.stop();
  const stopped = probe.exportLog();
  document.dispatchEvent(new CustomEvent("hnr:probe-call", { detail }));
  expect(probe.exportLog()).toBe(stopped);
});

it("keeps only an exact missing method expression and excludes quoted input or URL messages", () => {
  const probe = install();
  for (const message of ["bridge.nativeMethod is not a function", "'private-value' is not a function", "https://secret.invalid is not a function"]) {
    window.dispatchEvent(new ErrorEvent("error", { message }));
  }
  const report = probe.exportLog();
  expect(report).toContain('"missingMethod": "bridge.nativeMethod"');
  expect(report).not.toContain("private-value");
  expect(report).not.toContain("secret.invalid");
});

it("records long task durations and disconnects the observer when stopped", () => {
  let notify: PerformanceObserverCallback | undefined;
  const disconnect = vi.fn();
  const observe = vi.fn();
  class Observer {
    static supportedEntryTypes = ["longtask"];
    constructor(callback: PerformanceObserverCallback) { notify = callback; }
    disconnect = disconnect;
    observe = observe;
  }
  vi.stubGlobal("PerformanceObserver", Observer);
  const probe = install();
  const entry = { duration: 9900, startTime: performance.now(), name: "private-form-value" } as PerformanceEntry;
  notify?.({ getEntries: () => [entry] } as PerformanceObserverEntryList, {} as PerformanceObserver);
  expect(observe).toHaveBeenCalledWith({ type: "longtask" });
  expect(probe.exportLog()).toContain('"durationMs": 9900');
  expect(probe.exportLog()).not.toContain("private-form-value");
  probe.stop();
  expect(disconnect).toHaveBeenCalledOnce();
  const stopped = probe.exportLog();
  notify?.({ getEntries: () => [entry] } as PerformanceObserverEntryList, {} as PerformanceObserver);
  expect(probe.exportLog()).toBe(stopped);
});

it("keeps export controls outside inert background siblings when the workspace opens and closes", async () => {
  vi.useFakeTimers();
  const probe = install();
  const host = document.querySelector("#hnr-interaction-probe");
  const workspace = document.createElement("div");
  workspace.id = "hn-reader-workspace";
  host?.setAttribute("inert", "");
  document.body.append(workspace);
  await Promise.resolve();
  expect(host?.parentElement).toBe(workspace);
  expect(host?.hasAttribute("inert")).toBe(false);
  probe.stop();
  workspace.remove();
  await Promise.resolve();
  expect(host?.parentElement).toBe(document.body);
  probe.destroy();
});
