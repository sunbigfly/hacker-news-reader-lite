// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { HnHostThemeController } from "../src/host/hn-host-theme-controller";
import { LifecycleScope } from "../src/kernel/lifecycle";

describe("HnHostThemeController", () => {
  it("projects and exactly restores the host theme attribute", () => {
    document.documentElement.setAttribute("data-hnr-theme", "light");
    const scope = new LifecycleScope();
    const theme = new HnHostThemeController(document, scope);

    theme.apply("dark");
    expect(document.documentElement.getAttribute("data-hnr-theme")).toBe("dark");
    theme.apply("auto");
    expect(document.documentElement.getAttribute("data-hnr-theme")).toBe("auto");

    scope.destroy();
    expect(document.documentElement.getAttribute("data-hnr-theme")).toBe("light");
    document.documentElement.removeAttribute("data-hnr-theme");
  });

  it("defines separate explicit-dark and system-auto color palettes", () => {
    const css = readFileSync(resolve("lite/styles/05-host.css"), "utf8");
    expect(css).toContain('html.hnr-host-enhanced[data-hnr-theme="dark"]');
    expect(css).toContain('html.hnr-host-enhanced[data-hnr-theme="auto"]');
    expect(css).toContain("--hnr-host-topbar: #101419");
    expect(css).toContain("color-scheme: dark");
  });
});
