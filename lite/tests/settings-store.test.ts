import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  readerFontFamilyCss,
  SettingsStore,
} from "../src/settings/settings-store";

afterEach(() => vi.unstubAllGlobals());

describe("reader settings", () => {
  it("defaults AI RPM and TPM to zero and preserves explicit positive limits", () => {
    expect(DEFAULT_SETTINGS.ai).toMatchObject({ requestsPerMinute: 0, tokensPerMinute: 0 });
    expect(normalizeSettings({ ai: { requestsPerMinute: 30, tokensPerMinute: 120_000 } }).ai)
      .toMatchObject({ requestsPerMinute: 30, tokensPerMinute: 120_000 });
  });

  it("persists the explicit translation enabled state and defaults old records off", () => {
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, translationEnabled: true }).translationEnabled).toBe(true);
    expect(normalizeSettings({ schemaVersion: 1 }).translationEnabled).toBe(false);
  });

  it("defaults old records to the paper translation theme and normalizes saved choices", () => {
    expect(normalizeSettings({ schemaVersion: 1 }).translationTheme).toBe("paper");
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, translationTheme: "highlight" }).translationTheme).toBe("highlight");
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, translationTheme: "unknown" }).translationTheme).toBe("paper");
  });

  it("restores the saved automatic translation state in the next reader session", () => {
    let stored: unknown;
    vi.stubGlobal("GM_setValue", (_key: string, value: unknown) => { stored = value; });
    vi.stubGlobal("GM_getValue", (_key: string, fallback: unknown) => stored ?? fallback);
    const store = new SettingsStore();

    store.save({ ...DEFAULT_SETTINGS, translationEnabled: true });

    expect(store.load().translationEnabled).toBe(true);
  });

  it("migrates old records to the preserved serif default and normalizes font settings", () => {
    const old = normalizeSettings({ schemaVersion: 1 });
    expect(old).toMatchObject({
      titleFontFamily: "serif",
      titleCustomFontFamily: "",
      fontFamily: "serif",
      customFontFamily: "",
      fontRenderingEnabled: true,
      fontWeight: 400,
      fontScale: 1,
      lineHeight: 1.62,
    });

    const custom = normalizeSettings({
      titleFontFamily: "custom",
      titleCustomFontFamily: " Microsoft YaHei ",
      fontFamily: "custom",
      customFontFamily: "  Noto \"Reader\"; { Test }  ",
      fontRenderingEnabled: false,
      fontWeight: "600",
      fontScale: 9,
      lineHeight: 0,
    });
    expect(custom).toMatchObject({
      titleFontFamily: "custom",
      titleCustomFontFamily: "Microsoft YaHei",
      fontFamily: "custom",
      customFontFamily: "Noto Reader Test",
      fontRenderingEnabled: false,
      fontWeight: 600,
      fontScale: 1.35,
      lineHeight: 1.35,
    });
    expect(readerFontFamilyCss(custom.fontFamily, custom.customFontFamily)).toBe(
      "\"Noto Reader Test\",system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif",
    );
  });
});
