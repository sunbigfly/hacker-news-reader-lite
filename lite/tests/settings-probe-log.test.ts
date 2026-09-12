// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { SettingsProbeLog } from "../src/debug/settings-probe-log";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

function previous(log: SettingsProbeLog): { stopReason: string | null; entries: { type: string }[] } {
  return (JSON.parse(log.export()) as { previous: { stopReason: string | null; entries: { type: string }[] } }).previous;
}

it("recovers the last meaningful recording after an interruption and preserves it across empty reloads", () => {
  const log = new SettingsProbeLog(window);
  log.append("interaction", { kind: "touch", target: "input/number" }, true);
  log.persist(0);
  // Deliberately do not stop: simulate process termination before cleanup.
  const resumed = new SettingsProbeLog(window);
  expect(previous(resumed).stopReason).toBeNull();
  expect(previous(resumed).entries.map((entry) => entry.type)).toContain("interaction");
  resumed.stop("pagehide");
  const next = new SettingsProbeLog(window);
  expect(previous(next).stopReason).toBeNull();
  expect(previous(next).entries.map((entry) => entry.type)).toContain("interaction");
});

it("caps records, field lengths and persistence frequency", () => {
  const storageWrite = vi.spyOn(Storage.prototype, "setItem");
  const log = new SettingsProbeLog(window);
  for (let index = 0; index < 400; index += 1) {
    log.append("interaction", { index, target: "a".repeat(1000) }, true);
    log.persist();
  }
  expect(storageWrite).toHaveBeenCalledOnce();
  log.stop("manual");
  const report = JSON.parse(log.export()) as { current: { entries: unknown[]; dropped: number } };
  expect(report.current.entries).toHaveLength(200);
  expect(report.current.dropped).toBeGreaterThan(0);
  expect(log.export()).not.toContain("a".repeat(161));
  expect(storageWrite).toHaveBeenCalledTimes(2);
});

it("continues in memory when storage is blocked and ignores malformed saved data", () => {
  localStorage.setItem("hnr:settings-probe:current:v1", "broken json");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Quota exceeded"); });
  const log = new SettingsProbeLog(window);
  log.append("error", { category: "other" }, true);
  log.stop("manual");
  expect(JSON.parse(log.export()) as unknown).toMatchObject({ persistent: false, previous: null, current: { stopReason: "manual" } });
});

it("recovers logs through GM storage when the error-page origin denies localStorage", () => {
  const values = new Map<string, unknown>();
  vi.stubGlobal("GM_getValue", (key: string, fallback: unknown) => values.get(key) ?? fallback);
  vi.stubGlobal("GM_setValue", (key: string, value: unknown) => { values.set(key, value); });
  vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new DOMException("Opaque origin", "SecurityError"); });
  const log = new SettingsProbeLog(window);
  log.append("interaction", { kind: "touch" }, true);
  log.persist(0);
  const resumed = new SettingsProbeLog(window);
  expect(resumed.storageBackend).toBe("userscript");
  expect(resumed.persistent).toBe(true);
  expect(previous(resumed).entries.map((entry) => entry.type)).toContain("interaction");
});

it("migrates an older page-local recording into script storage", () => {
  const old = new SettingsProbeLog(window);
  old.append("interaction", { kind: "click" }, true);
  old.stop("manual");
  const values = new Map<string, unknown>();
  vi.stubGlobal("GM_getValue", (key: string, fallback: unknown) => values.get(key) ?? fallback);
  vi.stubGlobal("GM_setValue", (key: string, value: unknown) => { values.set(key, value); });
  const upgraded = new SettingsProbeLog(window);
  expect(upgraded.storageBackend).toBe("userscript");
  expect(previous(upgraded).stopReason).toBe("manual");
  expect(values.has("hnr:settings-probe:previous:v1")).toBe(true);
});

it("falls back to page storage if the script manager rejects its storage API", () => {
  vi.stubGlobal("GM_getValue", () => { throw new Error("Unavailable"); });
  vi.stubGlobal("GM_setValue", () => { throw new Error("Unavailable"); });
  const log = new SettingsProbeLog(window);
  log.append("interaction", { kind: "click" }, true);
  log.stop("manual");
  expect(log.storageBackend).toBe("page");
  expect(log.persistent).toBe(true);
  const resumed = new SettingsProbeLog(window);
  expect(previous(resumed).stopReason).toBe("manual");
});
