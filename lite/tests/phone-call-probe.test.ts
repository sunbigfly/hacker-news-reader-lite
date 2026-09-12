// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { tracePhoneCall } from "../src/debug/phone-call-probe";

afterEach(() => { vi.restoreAllMocks(); });

it("measures synchronous bridge blocking without changing the return value or recording data", () => {
  const events: unknown[] = [];
  const listener = (event: Event): void => { events.push((event as CustomEvent<unknown>).detail); };
  document.addEventListener("hnr:probe-call", listener);
  try {
    vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(100).mockReturnValueOnce(10100);
    const value = { secret: "private-result" };
    expect(tracePhoneCall("gm-http-client:GM_xmlhttpRequest", () => value)).toBe(value);
    expect(events).toEqual([
      { id: expect.any(Number) as number, owner: "gm-http-client:GM_xmlhttpRequest", phase: "start", durationMs: 0, failed: false },
      { id: expect.any(Number) as number, owner: "gm-http-client:GM_xmlhttpRequest", phase: "end", durationMs: 10000, failed: false },
    ]);
    expect(JSON.stringify(events)).not.toContain("private-result");
  } finally { document.removeEventListener("hnr:probe-call", listener); }
});

it("preserves thrown errors without copying their contents into diagnostics", () => {
  const events: unknown[] = [];
  const listener = (event: Event): void => { events.push((event as CustomEvent<unknown>).detail); };
  document.addEventListener("hnr:probe-call", listener);
  const error = new Error("private-error");
  try {
    expect(() => tracePhoneCall("settings-store:GM_getValue", () => { throw error; })).toThrow(error);
    expect(events.at(-1)).toMatchObject({ phase: "end", failed: true });
    expect(JSON.stringify(events)).not.toContain("private-error");
  } finally { document.removeEventListener("hnr:probe-call", listener); }
});
