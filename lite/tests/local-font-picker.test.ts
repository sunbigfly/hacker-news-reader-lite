// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLocalFontOptions,
  createBrowserLocalFontQuery,
} from "../src/settings/local-font-picker";

afterEach(() => {
  Reflect.deleteProperty(window, "queryLocalFonts");
  vi.restoreAllMocks();
});

describe("local font catalog", () => {
  it("deduplicates families, gives known Chinese fonts Chinese labels, and sorts them first", () => {
    const options = buildLocalFontOptions([
      " Arial ",
      "Microsoft YaHei",
      "Noto Sans CJK SC",
      "Arial",
      "",
    ]);

    expect(options).toHaveLength(3);
    expect(options.at(-1)).toMatchObject({ family: "Arial", chinesePreferred: false });
    expect(options.find((option) => option.family === "Microsoft YaHei")).toMatchObject({
      label: "微软雅黑（Microsoft YaHei）",
      chinesePreferred: true,
    });
    expect(options.find((option) => option.family === "Noto Sans CJK SC")?.searchText).toContain("思源黑体");
  });

  it("calls the browser API with its Window receiver and caches the complete family list", async () => {
    const queryLocalFonts = vi.fn(function (this: Window) {
      expect(this).toBe(window);
      return Promise.resolve([
        { family: "Arial" },
        { family: "Microsoft YaHei" },
        { family: "Microsoft YaHei" },
        { family: "" },
      ]);
    });
    Object.defineProperty(window, "queryLocalFonts", {
      configurable: true,
      value: queryLocalFonts,
    });

    const query = createBrowserLocalFontQuery(document);
    expect(query).toBeTypeOf("function");
    const first = await query?.();
    const second = await query?.();

    expect(first).toEqual(["Microsoft YaHei", "Arial"]);
    expect(second).toBe(first);
    expect(queryLocalFonts).toHaveBeenCalledOnce();
  });
});
