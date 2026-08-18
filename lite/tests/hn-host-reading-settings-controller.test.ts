// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HnHostReadingSettingsController } from "../src/host/hn-host-reading-settings-controller";
import { LifecycleScope } from "../src/kernel/lifecycle";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/settings/settings-store";

describe("HnHostReadingSettingsController", () => {
  it("projects Reader typography and restores the host", () => {
    document.documentElement.style.setProperty("--hnr-host-font-scale", "0.9");
    const scope = new LifecycleScope();
    const controller = new HnHostReadingSettingsController(document, scope);
    const settings = normalizeSettings({
      ...DEFAULT_SETTINGS,
      fontFamily: "cjkSans",
      fontWeight: 600,
      fontScale: 1.2,
      lineHeight: 1.8,
    });

    controller.apply(settings);

    expect(document.documentElement.style.getPropertyValue("--hnr-host-content-font-family"))
      .toContain("Noto Sans CJK SC");
    expect(document.documentElement.style.getPropertyValue("--hnr-host-content-font-weight")).toBe("600");
    expect(document.documentElement.style.getPropertyValue("--hnr-host-font-scale")).toBe("1.2");
    expect(document.documentElement.style.getPropertyValue("--hnr-host-line-height")).toBe("1.8");

    scope.destroy();
    expect(document.documentElement.style.getPropertyValue("--hnr-host-content-font-family")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--hnr-host-content-font-weight")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--hnr-host-font-scale")).toBe("0.9");
    expect(document.documentElement.style.getPropertyValue("--hnr-host-line-height")).toBe("");
    document.documentElement.style.removeProperty("--hnr-host-font-scale");
  });

  it("keeps host subtitles independent from Reader translation themes", () => {
    const css = readFileSync(resolve("lite/styles/05-host.css"), "utf8");

    expect(css).not.toContain("data-hnr-translation-theme");
    expect(css).toContain("html.hnr-host-list .hnr-title-translation");
    expect(css).toContain("font: 500 12px/1.35 ui-sans-serif, system-ui, sans-serif;");
    expect(css).toContain("--hnr-host-content-font-family");
  });
});
