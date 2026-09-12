/** Self-contained so the offline document can reuse the same interaction code. */
export function installSelectMenus(root: HTMLElement | ShadowRoot): {
  refresh(): void;
  close(restoreFocus?: boolean): boolean;
  destroy(): void;
} {
  const document = root.ownerDocument;
  const view = document.defaultView;
  if (!view) throw new Error("Select menus require a document with a window");
  const treeRoot = root.getRootNode();
  const portal = treeRoot instanceof view.ShadowRoot ? treeRoot : document.body;
  const controls = new Map<HTMLSelectElement, { wrapper: HTMLElement; button: HTMLButtonElement; value: HTMLElement; label: string; hidden: HTMLSelectElement["hidden"]; tabIndex: string | null }>();
  const cleanups: Array<() => void> = [];
  let current: HTMLSelectElement | null = null;
  let menu: HTMLElement | null = null;
  let activeIndex = -1;
  let menuId = 0;
  const listen = (target: EventTarget, type: string, listener: EventListener, capture = false): void => {
    target.addEventListener(type, listener, capture);
    cleanups.push(() => target.removeEventListener(type, listener, capture));
  };
  const enabledOptions = (select: HTMLSelectElement): HTMLOptionElement[] => [...select.options]
    .filter((option) => !option.hidden && !option.disabled && !(option.parentElement instanceof view.HTMLOptGroupElement && option.parentElement.disabled));
  const close = (restoreFocus = false): boolean => {
    if (!current) return false;
    const control = controls.get(current);
    current = null;
    menu?.remove();
    menu = null;
    control?.button.setAttribute("aria-expanded", "false");
    control?.button.removeAttribute("aria-activedescendant");
    control?.button.removeAttribute("aria-controls");
    if (restoreFocus) control?.button.focus({ preventScroll: true });
    return true;
  };
  const refresh = (): void => {
    for (const [select, control] of controls) {
      const label = select.selectedOptions[0]?.label ?? "请选择";
      if (control.value.textContent !== label) control.value.textContent = label;
      control.button.disabled = select.disabled;
      control.button.setAttribute("aria-label", `${control.label}：${label}`);
    }
    if (current?.disabled || (current && !current.isConnected)) close();
  };
  const choose = (option: HTMLOptionElement): void => {
    if (!current || !enabledOptions(current).includes(option)) return;
    const select = current;
    const changed = select.value !== option.value;
    select.value = option.value;
    close(true);
    refresh();
    if (changed) {
      select.dispatchEvent(new view.Event("input", { bubbles: true }));
      select.dispatchEvent(new view.Event("change", { bubbles: true }));
    }
  };
  const highlight = (index: number): void => {
    if (!current || !menu) return;
    const options = enabledOptions(current);
    activeIndex = Math.max(0, Math.min(options.length - 1, index));
    for (const element of menu.querySelectorAll<HTMLElement>("[data-option-index]")) {
      const option = current.options[Number(element.dataset.optionIndex)];
      const active = option === options[activeIndex];
      element.classList.toggle("active", active);
      if (active) {
        controls.get(current)?.button.setAttribute("aria-activedescendant", element.id);
        // Scroll only this list. scrollIntoView can also move the settings page
        // on mobile, triggering our ancestor-scroll dismissal immediately.
        const top = element.offsetTop;
        const bottom = top + element.offsetHeight;
        if (top < menu.scrollTop) menu.scrollTop = top;
        else if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight;
      }
    }
  };
  const open = (select: HTMLSelectElement): void => {
    const control = controls.get(select);
    if (select.disabled || !control) return;
    if (current === select) { close(); return; }
    close();
    refresh();
    current = select;
    menu = document.createElement("div");
    menu.className = "hnr-select-menu";
    menu.id = `hnr-select-menu-${++menuId}`;
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-label", control.label);
    const enabled = new Set(enabledOptions(select));
    for (const [index, option] of [...select.options].entries()) {
      if (option.hidden) continue;
      const item = document.createElement("div");
      item.className = "hnr-select-option";
      item.id = `${menu.id}-${index}`;
      item.dataset.optionIndex = String(index);
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(option.selected));
      item.setAttribute("aria-disabled", String(!enabled.has(option)));
      item.textContent = option.label;
      menu.append(item);
    }
    portal.append(menu);
    const rect = control.button.getBoundingClientRect();
    const viewport = view.visualViewport;
    const leftEdge = viewport?.offsetLeft ?? 0;
    const topEdge = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? view.innerWidth;
    const height = viewport?.height ?? view.innerHeight;
    const menuWidth = Math.max(0, Math.min(Math.max(rect.width, 160), width - 16));
    const below = topEdge + height - rect.bottom - 12;
    const above = rect.top - topEdge - 12;
    const upwards = below < Math.min(220, select.options.length * 44) && above > below;
    const maxHeight = Math.max(44, Math.min(320, upwards ? above : below));
    menu.style.width = `${menuWidth}px`;
    menu.style.maxHeight = `${maxHeight}px`;
    menu.style.left = `${Math.max(leftEdge + 8, Math.min(rect.left, leftEdge + width - menuWidth - 8))}px`;
    menu.style.top = `${upwards ? Math.max(topEdge + 8, rect.top - Math.min(menu.scrollHeight, maxHeight) - 4) : rect.bottom + 4}px`;
    control.button.setAttribute("aria-expanded", "true");
    control.button.setAttribute("aria-controls", menu.id);
    control.button.focus({ preventScroll: true });
    highlight(enabledOptions(select).findIndex((option) => option.selected));
    menu.addEventListener("click", (event) => {
      const item = (event.target as Element).closest<HTMLElement>("[data-option-index]");
      const option = item ? select.options[Number(item.dataset.optionIndex)] : undefined;
      if (option) choose(option);
    });
  };
  for (const select of root.querySelectorAll<HTMLSelectElement>("select")) {
    if (select.multiple || select.size > 1) continue;
    const wrapper = document.createElement("span");
    wrapper.className = "hnr-select";
    const button = document.createElement("button");
    button.type = "button";
    button.className = `hnr-select-trigger ${select.className}`.trim();
    button.setAttribute("role", "combobox");
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");
    const value = document.createElement("span");
    value.className = "hnr-select-value";
    button.append(value);
    const label = select.getAttribute("aria-label")
      ?? select.closest("label")?.querySelector("span")?.textContent
      ?? (select.name || "选项");
    controls.set(select, { wrapper, button, value, label, hidden: select.hidden, tabIndex: select.getAttribute("tabindex") });
    select.before(wrapper);
    wrapper.append(select, button);
    select.hidden = true;
    select.classList.add("hnr-select-native");
    select.tabIndex = -1;
    listen(button, "click", () => open(select));
    listen(button, "keydown", (event) => {
      const key = (event as KeyboardEvent).key;
      if (key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End") {
        event.preventDefault();
        event.stopPropagation();
        if (current !== select) { open(select); return; }
        const count = enabledOptions(select).length;
        highlight(key === "Home" ? 0 : key === "End" ? count - 1 : activeIndex + (key === "ArrowDown" ? 1 : -1));
      } else if ((key === "Enter" || key === " ") && current === select) {
        event.preventDefault();
        event.stopPropagation();
        const option = enabledOptions(select)[activeIndex];
        if (option) choose(option);
      } else if (key === "Tab") close();
    });
  }
  const observer = new view.MutationObserver(() => { if (current) close(); refresh(); });
  for (const select of controls.keys()) observer.observe(select, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ["disabled", "label", "value", "selected", "hidden"],
  });
  listen(root, "change", refresh);
  listen(root, "input", refresh);
  listen(root, "click", refresh);
  listen(document, "pointerdown", (event) => {
    const button = current ? controls.get(current)?.button : null;
    if (button && menu && !event.composedPath().includes(button) && !event.composedPath().includes(menu)) close();
  }, true);
  listen(document, "keydown", (event) => {
    if ((event as KeyboardEvent).key === "Escape" && close(true)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  listen(portal, "scroll", (event) => { if (menu && !menu.contains(event.target as Node)) close(); }, true);
  listen(view, "resize", () => { close(); });
  if (view.visualViewport) listen(view.visualViewport, "resize", () => { close(); });
  refresh();
  return { refresh, close, destroy: () => {
    close();
    observer.disconnect();
    for (const cleanup of cleanups) cleanup();
    for (const [select, control] of controls) {
      select.hidden = control.hidden;
      select.classList.remove("hnr-select-native");
      if (control.tabIndex === null) select.removeAttribute("tabindex");
      else select.setAttribute("tabindex", control.tabIndex);
      control.wrapper.replaceWith(select);
    }
    controls.clear();
  } };
}
