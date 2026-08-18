// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { containFloatingSurfaceWheel } from "../src/dom/floating-surface-wheel";

describe("floating surface wheel", () => {
  it("keeps inner scrolling and blocks scroll chaining at the boundary", () => {
    const surface = document.createElement("div");
    const scroller = document.createElement("div");
    const target = document.createElement("button");
    scroller.append(target);
    surface.append(scroller);
    document.body.append(surface);
    Object.defineProperties(scroller, { clientHeight: { value: 100 }, scrollHeight: { value: 300 } });
    const style = (element: Element) => ({ overflowX: "hidden", overflowY: element === scroller ? "auto" : "hidden" });
    const inside = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 });
    target.addEventListener("wheel", (event) => containFloatingSurfaceWheel(surface, event, style), { once: true });
    target.dispatchEvent(inside);
    expect(inside.defaultPrevented).toBe(false);
    scroller.scrollTop = 200;
    const boundary = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 });
    target.addEventListener("wheel", (event) => containFloatingSurfaceWheel(surface, event, style), { once: true });
    target.dispatchEvent(boundary);
    expect(boundary.defaultPrevented).toBe(true);
  });
});
