import type { Cleanup } from "../kernel/lifecycle";
import { eventElement } from "./event-target";

function wheelDelta(event: WheelEvent, surface: HTMLElement): { readonly x: number; readonly y: number } {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return { x: event.deltaX * 40, y: event.deltaY * 40 };
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return { x: event.deltaX * surface.clientWidth, y: event.deltaY * surface.clientHeight };
  return { x: event.deltaX, y: event.deltaY };
}

export function containFloatingSurfaceWheel(
  surface: HTMLElement,
  event: WheelEvent,
  style: (element: Element) => Pick<CSSStyleDeclaration, "overflowX" | "overflowY"> = (element) => getComputedStyle(element),
): void {
  event.stopPropagation();
  const target = eventElement(event);
  const { x, y } = wheelDelta(event, surface);
  if (!target || !surface.contains(target)) {
    if (x || y) event.preventDefault();
    return;
  }
  let scrollTarget: HTMLElement | null = target as HTMLElement;
  while (scrollTarget && surface.contains(scrollTarget)) {
    const computed = style(scrollTarget);
    const maxX = scrollTarget.scrollWidth - scrollTarget.clientWidth;
    const maxY = scrollTarget.scrollHeight - scrollTarget.clientHeight;
    const canX = Boolean(x && maxX > 1 && /(auto|scroll|overlay)/.test(computed.overflowX) && (x < 0 ? scrollTarget.scrollLeft > 0 : scrollTarget.scrollLeft < maxX - 1));
    const canY = Boolean(y && maxY > 1 && /(auto|scroll|overlay)/.test(computed.overflowY) && (y < 0 ? scrollTarget.scrollTop > 0 : scrollTarget.scrollTop < maxY - 1));
    if (canX || canY) return;
    if (scrollTarget === surface) break;
    scrollTarget = scrollTarget.parentElement;
  }
  if (x || y) event.preventDefault();
}

export function bindFloatingSurfaceWheel(surface: HTMLElement): Cleanup {
  const options: AddEventListenerOptions = { passive: false };
  const listener = (event: Event): void => containFloatingSurfaceWheel(surface, event as WheelEvent);
  surface.addEventListener("wheel", listener, options);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    surface.removeEventListener("wheel", listener, options);
  };
}
