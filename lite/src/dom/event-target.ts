export function eventPath(event: Event): readonly EventTarget[] {
  try {
    const path = event.composedPath?.();
    if (path?.length) return path;
  } catch {
    // Incomplete browser test doubles fall back to target.
  }
  return event.target ? Object.freeze([event.target]) : Object.freeze([]);
}

export function eventElement(event: Event): Element | null {
  for (const target of eventPath(event)) {
    if (target !== null && typeof target === "object" && (target as Node).nodeType === 1) {
      return target as Element;
    }
  }
  return null;
}

export function eventPathIncludes(event: Event, node: Node | null): boolean {
  if (!node) return false;
  if (eventPath(event).includes(node)) return true;
  const target = event.target;
  return target !== null
    && typeof target === "object"
    && typeof (target as Node).nodeType === "number"
    && node.contains(target as Node);
}

export function usesNativeLinkNavigation(event: MouseEvent): boolean {
  return event.button !== 0
    || event.metaKey
    || event.ctrlKey
    || event.shiftKey
    || event.altKey;
}

export function deepActiveElement(document: Document): Element | null {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}
