import { describe, expect, it } from "vitest";
import { VirtualCommentLayout } from "../src/stream/virtual-comment-layout";

describe("VirtualCommentLayout", () => {
  it("mounts at least two viewport heights for translation preloading", () => {
    const layout = new VirtualCommentLayout({ defaultHeight: 100, overscanPx: 200, maxMounted: 120 });
    layout.setCount(100);
    const range = layout.range(0, 900);
    expect(range.end).toBeGreaterThanOrEqual(18);
    expect(range.viewportStart).toBe(0);
    expect(range.viewportEnd).toBe(9);
    expect(range.topSpacer).toBe(0);
  });

  it("never mounts more than 120 entries for a giant branch", () => {
    const layout = new VirtualCommentLayout({ defaultHeight: 100, overscanPx: 500, maxMounted: 120 });
    layout.setCount(1_000);
    for (const scrollTop of [0, 10_000, 50_000, 99_000]) {
      const range = layout.range(scrollTop, 800);
      expect(range.end - range.start).toBeLessThanOrEqual(120);
      expect(range.topSpacer + range.bottomSpacer).toBeLessThanOrEqual(range.totalHeight);
    }
    expect(layout.range(99_000, 800).end - layout.range(99_000, 800).start).toBeLessThan(30);
    expect(layout.updateHeight(500, 260)).toBe(true);
    expect(layout.updateHeight(500, 260)).toBe(false);
    expect(layout.offsetFor(501)).toBe(50_260);
  });
});
