// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { eventElement, eventPathIncludes, usesNativeLinkNavigation } from "../src/dom/event-target";
import { htmlElement } from "../src/dom/html-element";

describe("DOM helpers", () => {
  it("creates safe text nodes and resolves delegated targets", () => {
    const button = htmlElement(document, "button", "action", "<unsafe>");
    document.body.append(button);
    let captured: Event | undefined;
    button.addEventListener("click", (event) => { captured = event; });
    button.click();
    expect(button.textContent).toBe("<unsafe>");
    if (!captured) throw new Error("click event was not captured");
    expect(eventElement(captured)).toBe(button);
    expect(eventPathIncludes(captured, button)).toBe(true);
  });

  it("preserves modified and middle link navigation", () => {
    expect(usesNativeLinkNavigation(new MouseEvent("click", { button: 0 }))).toBe(false);
    expect(usesNativeLinkNavigation(new MouseEvent("click", { ctrlKey: true }))).toBe(true);
    expect(usesNativeLinkNavigation(new MouseEvent("click", { button: 1 }))).toBe(true);
  });
});
