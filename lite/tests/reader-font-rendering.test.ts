// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  applyReaderFontRendering,
  readerFontRenderingDefaults,
} from "../src/font/reader-font-rendering";

describe("Reader font rendering", () => {
  it("selects the adapted rendering profile for Blink, Gecko, and WebKit", () => {
    expect(readerFontRenderingDefaults({ userAgent: "Chrome/140 AppleWebKit/537.36", platform: "Win32" }))
      .toMatchObject({ stroke: 0.015, shadow: 0.75, macSmoothing: false });
    expect(readerFontRenderingDefaults({ userAgent: "Firefox/141", platform: "Linux x86_64" }))
      .toMatchObject({ stroke: 0.03, shadow: 0.55, macSmoothing: false });
    expect(readerFontRenderingDefaults({ userAgent: "Version/18.6 Safari/605.1 AppleWebKit/605.1", platform: "MacIntel" }))
      .toMatchObject({ stroke: 0.05, shadow: 0.45, macSmoothing: true });
  });

  it("projects the rendering variables and preserves an explicit off state", () => {
    const root = document.createElement("div");
    const environment = { userAgent: "Chrome/140 AppleWebKit/537.36", platform: "Win32" };

    applyReaderFontRendering(root, true, environment);
    expect(root.dataset.fontRendering).toBe("builtin");
    expect(root.style.getPropertyValue("--hnr-font-rendering-stroke-runtime")).toBe("0.015px currentColor");
    expect(root.style.getPropertyValue("--hnr-font-rendering-shadow-runtime")).toBe("0 0 0.75px #7c7c7cdd");

    applyReaderFontRendering(root, false, environment);
    expect(root.dataset.fontRendering).toBe("off");
  });
});
