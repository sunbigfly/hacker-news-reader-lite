import { LifecycleScope } from "../kernel/lifecycle";
import {
  DEFAULT_READER_RATIO,
  normalizeReaderRatio,
} from "../settings/reader-workspace-state-store";

export const READER_EMBED_RATIO = DEFAULT_READER_RATIO;

export function readerEmbedWidth(viewportWidth: number, readerRatio = READER_EMBED_RATIO): number {
  return Math.round(Math.max(0, viewportWidth) * normalizeReaderRatio(readerRatio));
}

export interface ReaderWorkspaceOptions {
  readonly readerRatio?: number;
  readonly onReaderRatioChange?: (readerRatio: number) => void;
}

function percentage(ratio: number): string {
  return `${Number((ratio * 100).toFixed(2))}%`;
}

function ownStyle(
  restorers: Array<() => void>,
  element: HTMLElement,
  property: string,
  value: string,
): void {
  const previous = element.style.getPropertyValue(property);
  const priority = element.style.getPropertyPriority(property);
  restorers.push(() => {
    if (previous) element.style.setProperty(property, previous, priority);
    else element.style.removeProperty(property);
  });
  element.style.setProperty(property, value, "important");
}

/** Owns reversible HN host truncation and the adjustable right reader pane. */
export class ReaderWorkspace {
  readonly scope: LifecycleScope;
  readonly root: HTMLDivElement;
  readonly divider: HTMLDivElement;
  readonly mount: HTMLDivElement;
  readonly #style: HTMLStyleElement;

  constructor(
    readonly document: Document,
    parentScope: LifecycleScope,
    options: ReaderWorkspaceOptions = {},
  ) {
    this.scope = parentScope.child();
    const html = document.documentElement;
    const body = document.body;
    const center = body.querySelector<HTMLElement>(":scope > center");
    const hnMain = document.querySelector<HTMLElement>("#hnmain");
    const topbar = document.querySelector<HTMLElement>("[data-hnr-topbar]");
    const measuredTopbarHeight = Math.ceil(topbar?.getBoundingClientRect().height ?? 0);
    const topbarHeight = measuredTopbarHeight > 0 ? measuredTopbarHeight : 48;
    const pageWindow = document.defaultView;
    const initialScrollY = pageWindow?.scrollY ?? 0;
    const styleRestorers: Array<() => void> = [];
    const hadWorkspaceClass = html.classList.contains("hnr-reader-embedded-right");
    let currentRatio = normalizeReaderRatio(options.readerRatio);
    let committedRatio = currentRatio;
    html.classList.add("hnr-reader-embedded-right");
    ownStyle(styleRestorers, html, "--hnr-reader-workspace-width", percentage(currentRatio));
    ownStyle(styleRestorers, html, "--hnr-host-workspace-width", percentage(1 - currentRatio));
    ownStyle(styleRestorers, html, "--hnr-host-topbar-height", `${topbarHeight}px`);
    ownStyle(styleRestorers, html, "overflow-x", "hidden");
    ownStyle(styleRestorers, html, "overflow-y", "hidden");
    ownStyle(styleRestorers, html, "height", "100dvh");
    for (const [property, value] of [
      ["box-sizing", "border-box"],
      ["width", percentage(1 - currentRatio)],
      ["min-width", "0"],
      ["max-width", percentage(1 - currentRatio)],
      ["height", "100dvh"],
      ["max-height", "100dvh"],
      ["overflow-x", "hidden"],
      ["overflow-y", center ? "hidden" : "auto"],
      ["overscroll-behavior", "contain"],
      ["scrollbar-gutter", center ? "auto" : "stable"],
    ] as const) ownStyle(styleRestorers, body, property, value);
    if (center) {
      for (const [property, value] of [
        ["box-sizing", "border-box"],
        ["position", "fixed"],
        ["top", "var(--hnr-host-topbar-height)"],
        ["right", "auto"],
        ["bottom", "0"],
        ["left", "0"],
        ["width", "var(--hnr-host-workspace-width)"],
        ["min-width", "0"],
        ["max-width", "var(--hnr-host-workspace-width)"],
        ["height", "calc(100dvh - var(--hnr-host-topbar-height))"],
        ["max-height", "calc(100dvh - var(--hnr-host-topbar-height))"],
        ["margin-left", "0"],
        ["margin-right", "0"],
        ["overflow-x", "hidden"],
        ["overflow-y", "auto"],
        ["overscroll-behavior", "contain"],
        ["scrollbar-gutter", "stable"],
      ] as const) ownStyle(styleRestorers, center, property, value);
      if (initialScrollY > 0) center.scrollTop = initialScrollY;
    } else if (initialScrollY > 0) {
      body.scrollTop = initialScrollY;
    }
    if (hnMain) {
      for (const [property, value] of [
        ["box-sizing", "border-box"],
        ["width", "100%"],
        ["min-width", "0"],
        ["max-width", "100%"],
        ["margin-left", "0"],
        ["margin-right", "0"],
      ] as const) ownStyle(styleRestorers, hnMain, property, value);
    }

    this.#style = document.createElement("style");
    this.#style.dataset.hnrWorkspaceStyle = "true";
    this.#style.textContent = `
html.hnr-reader-embedded-right { height: 100dvh !important; overflow: hidden !important; }
html.hnr-reader-embedded-right body {
  box-sizing: border-box !important;
  width: var(--hnr-host-workspace-width) !important;
  min-width: 0 !important;
  max-width: var(--hnr-host-workspace-width) !important;
  height: 100dvh !important;
  max-height: 100dvh !important;
  margin: 0 !important;
  overflow-x: hidden !important;
  overflow-y: hidden !important;
  overscroll-behavior: contain !important;
  scrollbar-gutter: auto !important;
}
html.hnr-reader-embedded-right body > center {
  position: fixed !important;
  inset: var(--hnr-host-topbar-height) auto 0 0 !important;
  box-sizing: border-box !important;
  width: var(--hnr-host-workspace-width) !important;
  min-width: 0 !important;
  max-width: var(--hnr-host-workspace-width) !important;
  height: calc(100dvh - var(--hnr-host-topbar-height)) !important;
  max-height: calc(100dvh - var(--hnr-host-topbar-height)) !important;
  margin: 0 !important;
  padding-left: 5px !important;
  overflow-x: hidden !important;
  overflow-y: auto !important;
  overscroll-behavior: contain !important;
  scrollbar-color: #a7adb2 transparent !important;
  scrollbar-width: thin !important;
  scrollbar-gutter: stable !important;
}
html.hnr-reader-embedded-right body > center::-webkit-scrollbar { width: 5px; height: 5px; }
html.hnr-reader-embedded-right body > center::-webkit-scrollbar-track { background: transparent; }
html.hnr-reader-embedded-right body > center::-webkit-scrollbar-thumb { border-radius: 999px; background: #a7adb2; }
html.hnr-reader-embedded-right body > center::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
html.hnr-reader-embedded-right #hnmain {
  box-sizing: border-box !important;
  width: 100% !important;
  min-width: 0 !important;
  max-width: 100% !important;
  margin-inline: 0 !important;
}
html.hnr-reader-embedded-right #hnmain > tbody > tr:first-child {
  position: fixed !important;
  z-index: 100 !important;
  top: 0 !important;
  left: 0 !important;
  width: var(--hnr-host-workspace-width) !important;
}
html.hnr-reader-embedded-right [data-hnr-topbar] {
  box-sizing: border-box !important;
  width: 100% !important;
}
html.hnr-reader-resizing, html.hnr-reader-resizing * { cursor: col-resize !important; user-select: none !important; }
#hn-reader-workspace {
  position: fixed;
  z-index: 2147483640;
  inset: 0 0 0 auto;
  display: block;
  width: var(--hnr-reader-workspace-width);
  height: 100dvh;
  overflow: hidden;
  border-left: 0;
  background: #fff;
  box-shadow: none;
}
.hnr-workspace-divider {
  position: absolute;
  z-index: 6;
  inset: 0 auto 0 0;
  width: 9px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: col-resize;
  touch-action: none;
}
.hnr-workspace-divider::before {
  position: absolute;
  inset: 0 auto 0 0;
  width: 1px;
  background: #a7adb2;
  content: "";
}
.hnr-workspace-divider:hover::before,
.hnr-workspace-divider:focus-visible::before,
html.hnr-reader-resizing .hnr-workspace-divider::before { width: 2px; background: #7d858b; }
.hnr-workspace-divider:focus-visible { outline: 2px solid #f26b2d; outline-offset: -2px; }
.hnr-workspace-mount { width: 100%; height: 100%; overflow: hidden; }
#hn-reader-workspace > #hn-reader-root { display: block; width: 100%; height: 100%; }
.hnr-workspace-loading {
  display: grid;
  height: 100%;
  place-items: center;
  padding: 32px;
  color: #596773;
  font: 14px/1.6 system-ui, sans-serif;
}
@media (prefers-reduced-motion: no-preference) {
  #hn-reader-workspace { animation: hnr-workspace-in .2s cubic-bezier(.22, 1, .36, 1) both; }
  @keyframes hnr-workspace-in { from { opacity: .55; clip-path: inset(0 0 0 100%); } to { opacity: 1; clip-path: inset(0); } }
}`;
    document.head.append(this.#style);

    this.root = document.createElement("div");
    this.root.id = "hn-reader-workspace";
    this.root.setAttribute("role", "complementary");
    this.root.setAttribute("aria-label", "Hacker News Reader");
    for (const [property, value] of [
      ["position", "fixed"],
      ["z-index", "2147483640"],
      ["top", "0"],
      ["right", "0"],
      ["bottom", "0"],
      ["left", "auto"],
      ["display", "block"],
      ["width", percentage(currentRatio)],
      ["height", "100dvh"],
      ["box-sizing", "border-box"],
      ["overflow", "hidden"],
      ["contain", "layout paint style"],
      ["isolation", "isolate"],
    ] as const) this.root.style.setProperty(property, value, "important");

    this.divider = document.createElement("div");
    this.divider.className = "hnr-workspace-divider";
    this.divider.tabIndex = 0;
    this.divider.setAttribute("role", "separator");
    this.divider.setAttribute("aria-label", "调整宿主与阅读器宽度");
    this.divider.setAttribute("aria-orientation", "vertical");

    this.mount = document.createElement("div");
    this.mount.className = "hnr-workspace-mount";
    this.root.append(this.divider, this.mount);
    html.append(this.root);

    const applyRatio = (nextRatio: number): void => {
      currentRatio = normalizeReaderRatio(nextRatio);
      const readerWidth = percentage(currentRatio);
      const hostWidth = percentage(1 - currentRatio);
      html.style.setProperty("--hnr-reader-workspace-width", readerWidth, "important");
      html.style.setProperty("--hnr-host-workspace-width", hostWidth, "important");
      body.style.setProperty("width", hostWidth, "important");
      body.style.setProperty("max-width", hostWidth, "important");
      this.root.style.setProperty("width", readerWidth, "important");
      this.divider.setAttribute("aria-valuemin", "32");
      this.divider.setAttribute("aria-valuemax", "75");
      this.divider.setAttribute("aria-valuenow", String(Math.round(currentRatio * 100)));
      this.divider.setAttribute("aria-valuetext", `阅读器 ${Math.round(currentRatio * 100)}%，宿主 ${Math.round((1 - currentRatio) * 100)}%`);
    };
    const commitRatio = (): void => {
      if (Math.abs(currentRatio - committedRatio) < 0.0001) return;
      committedRatio = currentRatio;
      options.onReaderRatioChange?.(currentRatio);
    };
    applyRatio(currentRatio);

    let activePointerId: number | null = null;
    const pointerId = (event: Event): number => (event as PointerEvent).pointerId ?? 0;
    const updateFromPointer = (event: Event): void => {
      if (activePointerId === null || pointerId(event) !== activePointerId || !pageWindow) return;
      const viewportWidth = Math.max(1, html.clientWidth || pageWindow.innerWidth);
      const clientX = (event as PointerEvent).clientX;
      applyRatio((viewportWidth - clientX) / viewportWidth);
      event.preventDefault();
    };
    const finishPointer = (event: Event): void => {
      if (activePointerId === null || pointerId(event) !== activePointerId) return;
      updateFromPointer(event);
      activePointerId = null;
      html.classList.remove("hnr-reader-resizing");
      commitRatio();
    };
    this.scope.listen(this.divider, "pointerdown", (event) => {
      if (event instanceof MouseEvent && event.button !== 0) return;
      activePointerId = pointerId(event);
      html.classList.add("hnr-reader-resizing");
      updateFromPointer(event);
    });
    if (pageWindow) {
      this.scope.listen(pageWindow, "pointermove", updateFromPointer);
      this.scope.listen(pageWindow, "pointerup", finishPointer);
      this.scope.listen(pageWindow, "pointercancel", finishPointer);
    }
    this.scope.listen(this.divider, "keydown", (event) => {
      if (!(event instanceof KeyboardEvent) || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
      const direction = event.key === "ArrowLeft" ? 1 : -1;
      applyRatio(currentRatio + direction * (event.shiftKey ? 0.05 : 0.02));
      commitRatio();
      event.preventDefault();
    });
    this.scope.add(() => html.classList.remove("hnr-reader-resizing"));

    this.scope.add(() => {
      const hostScrollTop = center?.scrollTop ?? body.scrollTop;
      this.root.remove();
      this.#style.remove();
      for (const restore of styleRestorers.reverse()) restore();
      if (!hadWorkspaceClass) html.classList.remove("hnr-reader-embedded-right");
      if (hostScrollTop > 0) queueMicrotask(() => pageWindow?.scrollTo(0, hostScrollTop));
    });
  }

  showLoading(message = "正在载入 Hacker News 评论页…"): void {
    const loading = this.document.createElement("div");
    loading.className = "hnr-workspace-loading";
    loading.setAttribute("role", "status");
    loading.textContent = message;
    this.mount.replaceChildren(loading);
  }

  destroy(): void {
    this.scope.destroy();
  }
}
