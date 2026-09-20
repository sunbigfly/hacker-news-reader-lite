// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { installSelectMenus } from "../src/dom/select-menu";

const cleanups: Array<() => void> = [];
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing select menu fixture element");
  return value;
}
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture(): { root: ShadowRoot; form: HTMLFormElement; select: HTMLSelectElement; menus: ReturnType<typeof installSelectMenus>; button: HTMLButtonElement } {
  document.body.replaceChildren();
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = '<form><label><span>翻译服务</span><select name="provider" tabindex="2"><option value="auto">公共自动</option><option value="google" selected>Google</option><option value="disabled" disabled>不可用</option><option value="ai">自定义 AI</option></select></label></form>';
  const form = required(root.querySelector<HTMLFormElement>("form"));
  const select = required(root.querySelector<HTMLSelectElement>("select"));
  const menus = installSelectMenus(form);
  cleanups.push(() => menus.destroy());
  return { root, form, select, menus, button: required(root.querySelector<HTMLButtonElement>(".hnr-select-trigger")) };
}

it("uses the styled menu without losing native form values, events, or disabled options", () => {
  const { root, form, select, menus, button } = fixture();
  const input = vi.fn(); const change = vi.fn();
  select.addEventListener("input", input);
  select.addEventListener("change", change);
  expect(button.getAttribute("aria-label")).toBe("翻译服务：Google");
  button.click();
  expect(root.querySelector('[role="listbox"]')).not.toBeNull();
  required(root.querySelector<HTMLElement>('[data-option-index="2"]')).click();
  expect(select.value).toBe("google");
  required(root.querySelector<HTMLElement>('[data-option-index="3"]')).click();
  expect(new FormData(form).get("provider")).toBe("ai");
  expect(input).toHaveBeenCalledOnce();
  expect(change).toHaveBeenCalledOnce();
  expect(root.activeElement).toBe(button);
  expect(root.querySelector('[role="listbox"]')).toBeNull();
  menus.destroy();
  expect(select.hidden).toBe(false);
  expect(select.tabIndex).toBe(2);
  expect(select.parentElement?.tagName).toBe("LABEL");
  expect(root.querySelector(".hnr-select-trigger")).toBeNull();
});

it("supports keyboard selection, closes only the top menu on Escape, and bounds the popup to the viewport", () => {
  const { root, select, button } = fixture();
  vi.stubGlobal("innerWidth", 440);
  vi.stubGlobal("innerHeight", 600);
  vi.spyOn(button, "getBoundingClientRect").mockReturnValue({ left: 400, right: 700, top: 540, bottom: 584, width: 300, height: 44, x: 400, y: 540, toJSON: () => ({}) });
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(200);
  const escape = vi.fn();
  document.addEventListener("keydown", escape);
  cleanups.push(() => document.removeEventListener("keydown", escape));
  const key = (value: string): void => { button.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, composed: true, cancelable: true })); };
  key("ArrowDown");
  const menu = required(root.querySelector<HTMLElement>(".hnr-select-menu"));
  expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(8);
  expect(Number.parseFloat(menu.style.left) + Number.parseFloat(menu.style.width)).toBeLessThanOrEqual(432);
  expect(Number.parseFloat(menu.style.top) + 200).toBeLessThan(540);
  key("End"); key("Enter");
  expect(select.value).toBe("ai");
  button.click(); key("Escape");
  expect(root.querySelector(".hnr-select-menu")).toBeNull();
  expect(escape.mock.calls.some(([event]) => (event as KeyboardEvent).key === "Escape")).toBe(false);
});

it("reflects asynchronously loaded options and closes when the form scrolls or an outside pointer starts", async () => {
  const { root, form, select, button } = fixture();
  select.replaceChildren(new Option("新模型", "model", true, true));
  select.disabled = true;
  await Promise.resolve();
  expect(button.disabled).toBe(true);
  expect(button.textContent).toBe("新模型");
  select.disabled = false;
  await Promise.resolve();
  button.click();
  form.dispatchEvent(new Event("scroll"));
  expect(root.querySelector(".hnr-select-menu")).toBeNull();
  button.click();
  document.body.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true }));
  expect(root.querySelector(".hnr-select-menu")).toBeNull();
});

it("can run from serialized source in the standalone offline document", () => {
  const form = document.createElement("form");
  form.innerHTML = '<select name="mode" aria-label="翻译显示"><option value="original">原文</option><option value="bilingual">双语</option></select>';
  document.body.append(form);
  const install = window.eval(`(${installSelectMenus.toString()})`) as typeof installSelectMenus;
  const menus = install(form);
  cleanups.push(() => menus.destroy());
  required(form.querySelector<HTMLButtonElement>(".hnr-select-trigger")).click();
  required(document.querySelector<HTMLElement>('[data-option-index="1"]')).click();
  expect(new FormData(form).get("mode")).toBe("bilingual");
});

it("reveals the active option by scrolling only the menu, without scrolling its ancestors", () => {
  const { root, form, button } = fixture();
  // A WebView may scroll the containing page when scrollIntoView is used.
  const scrollIntoView = vi.fn(() => { queueMicrotask(() => form.dispatchEvent(new Event("scroll"))); });
  const previous = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  Object.defineProperty(Element.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
  cleanups.push(() => {
    if (previous) Object.defineProperty(Element.prototype, "scrollIntoView", previous);
    else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  });
  button.click();
  expect(scrollIntoView).not.toHaveBeenCalled();
  const menu = required(root.querySelector<HTMLElement>(".hnr-select-menu"));
  const option = required(menu.querySelector<HTMLElement>('[data-option-index="3"]'));
  Object.defineProperties(menu, { clientHeight: { value: 80 }, scrollTop: { value: 0, writable: true } });
  Object.defineProperties(option, { offsetTop: { value: 140 }, offsetHeight: { value: 40 } });
  button.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, composed: true }));
  expect(menu.scrollTop).toBe(100);
  expect(root.querySelector(".hnr-select-menu")).toBe(menu);
});

it("keeps the popup open when the settings surface scrolls to reveal the trigger", () => {
  const { root, form, button } = fixture();
  // Tapping the trigger makes a mobile browser scroll the surrounding surface
  // to reveal the focused control; that scroll must not dismiss the popup.
  const surface = document.createElement("div");
  surface.style.overflow = "auto";
  form.before(surface);
  surface.append(form);
  vi.spyOn(button, "getBoundingClientRect").mockReturnValue({ left: 40, right: 340, top: 100, bottom: 144, width: 300, height: 44, x: 40, y: 100, toJSON: () => ({}) });
  button.click();
  const menu = required(root.querySelector<HTMLElement>(".hnr-select-menu"));
  surface.dispatchEvent(new Event("scroll"));
  expect(root.querySelector(".hnr-select-menu")).toBe(menu);
});

it("follows the trigger as its surface scrolls and closes once it leaves the viewport", () => {
  const { root, form, button } = fixture();
  const surface = document.createElement("div");
  surface.style.overflow = "auto";
  form.before(surface);
  surface.append(form);
  const rect = vi.spyOn(button, "getBoundingClientRect");
  rect.mockReturnValue({ left: 40, right: 340, top: 100, bottom: 144, width: 300, height: 44, x: 40, y: 100, toJSON: () => ({}) });
  button.click();
  const menu = required(root.querySelector<HTMLElement>(".hnr-select-menu"));
  expect(menu.style.top).toBe("148px");
  rect.mockReturnValue({ left: 40, right: 340, top: 40, bottom: 84, width: 300, height: 44, x: 40, y: 40, toJSON: () => ({}) });
  surface.dispatchEvent(new Event("scroll"));
  expect(root.querySelector(".hnr-select-menu")).toBe(menu);
  expect(menu.style.top).toBe("88px");
  rect.mockReturnValue({ left: 40, right: 340, top: -200, bottom: -156, width: 300, height: 44, x: 40, y: -200, toJSON: () => ({}) });
  surface.dispatchEvent(new Event("scroll"));
  expect(root.querySelector(".hnr-select-menu")).toBeNull();
});

it("portals the popup as a sibling of the surface so no scroll container clips it", () => {
  const { root, button } = fixture();
  button.click();
  const menu = required(root.querySelector<HTMLElement>(".hnr-select-menu"));
  expect(menu.parentNode).toBe(root);
  expect(menu.parentElement).toBeNull();
});

it("anchors beside the trigger when a contained reader workspace offsets fixed positioning", () => {
  const { root, button } = fixture();
  vi.stubGlobal("innerWidth", 1600);
  vi.stubGlobal("innerHeight", 900);
  const buttonRect = vi.spyOn(button, "getBoundingClientRect");
  buttonRect.mockReturnValue({ left: 1210, right: 1510, top: 760, bottom: 804, width: 300, height: 44, x: 1210, y: 760, toJSON: () => ({}) });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element): DOMRect {
    if (!this.classList.contains("hnr-select-menu")) {
      return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
    }
    const element = this as HTMLElement;
    const left = 900 + (Number.parseFloat(element.style.left) || 0);
    const top = 100 + (Number.parseFloat(element.style.top) || 0);
    return { left, right: left, top, bottom: top, width: 0, height: 0, x: left, y: top, toJSON: () => ({}) };
  });
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(120);
  button.click();
  const menu = required(root.querySelector<HTMLElement>(".hnr-select-menu"));
  // The workspace starts at viewport (900,100), so viewport trigger coordinates
  // must be converted to workspace-local CSS coordinates before assignment.
  expect(menu.style.left).toBe("310px");
  expect(menu.style.top).toBe("536px");
  expect(900 + Number.parseFloat(menu.style.left)).toBe(1210);
  expect(100 + Number.parseFloat(menu.style.top) + 120 + 4).toBe(760);
});
