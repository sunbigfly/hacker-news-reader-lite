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
