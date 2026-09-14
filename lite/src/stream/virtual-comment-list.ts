import { LifecycleScope } from "../kernel/lifecycle";
import type { VisibleEntry } from "../thread/comment-projection";
import type { CommentId } from "../thread/model";
import { VirtualCommentLayout } from "./virtual-comment-layout";

export type CommentEntryRenderer = (entry: VisibleEntry, index: number) => HTMLElement;
export type RenderedEntriesListener = (
  entries: readonly VisibleEntry[],
  viewportEntries: readonly VisibleEntry[],
  notifyViewportChange: boolean,
) => void;

export interface VirtualCommentPosition {
  readonly id: CommentId;
  readonly offset: number;
}

function heightIdentity(entry: VisibleEntry): string {
  const state = entry.kind === "comment" ? `${entry.collapsed}:${entry.repliesExpanded ?? ""}` : "";
  return `${entry.kind}:${entry.id}:${entry.depth}:${state}`;
}

export class VirtualCommentList {
  readonly #scope: LifecycleScope;
  readonly #layout: VirtualCommentLayout;
  readonly #top: HTMLDivElement;
  readonly #items: HTMLDivElement;
  readonly #bottom: HTMLDivElement;
  readonly #resizeObserver: ResizeObserver | null;
  #entries: readonly VisibleEntry[] = [];
  readonly #measuredHeights = new Map<string, number>();
  #frame: number | null = null;
  #notifyViewportChange = false;
  #ignoredScrollTop: number | null = null;
  #paused = false;
  #pendingRefresh = false;

  constructor(
    readonly container: HTMLElement,
    readonly renderEntry: CommentEntryRenderer,
    parentScope?: LifecycleScope,
    layout = new VirtualCommentLayout(),
    readonly onRenderedEntries?: RenderedEntriesListener,
  ) {
    this.#scope = LifecycleScope.ownedBy(parentScope);
    this.#layout = layout;
    this.#top = container.ownerDocument.createElement("div");
    this.#items = container.ownerDocument.createElement("div");
    this.#bottom = container.ownerDocument.createElement("div");
    this.#top.className = "hnr-virtual-spacer";
    this.#items.className = "hnr-virtual-items";
    this.#bottom.className = "hnr-virtual-spacer";
    container.replaceChildren(this.#top, this.#items, this.#bottom);
    this.#scope.listen(container, "scroll", () => {
      const ignored = this.#ignoredScrollTop !== null
        && Math.abs(container.scrollTop - this.#ignoredScrollTop) <= 1;
      this.#ignoredScrollTop = null;
      this.schedule(!ignored);
    });
    const ResizeObserverConstructor = container.ownerDocument.defaultView?.ResizeObserver;
    this.#resizeObserver = ResizeObserverConstructor
      ? new ResizeObserverConstructor((records) => {
          const anchor = this.#layout.anchorAt(container.scrollTop);
          let changed = false;
          for (const record of records) {
            const target = record.target as HTMLElement;
            // A queued observation may belong to the projection that was just replaced.
            if (target.parentElement !== this.#items) continue;
            const index = Number.parseInt(target.dataset.virtualIndex ?? "", 10);
            const entry = this.#entries[index];
            if (!entry) continue;
            this.#measuredHeights.set(heightIdentity(entry), record.contentRect.height);
            changed = this.#layout.updateHeight(index, record.contentRect.height) || changed;
          }
          if (!changed) return;
          this.#restoreAnchor(anchor);
          this.schedule();
        })
      : null;
    if (this.#resizeObserver) this.#scope.add(() => this.#resizeObserver?.disconnect());
    this.#scope.add(() => {
      if (this.#frame !== null) this.#cancelFrame(this.#frame);
      this.#frame = null;
      this.#measuredHeights.clear();
      container.replaceChildren();
    });
  }

  get mountedCount(): number {
    return this.#items.childElementCount;
  }

  capturePosition(): VirtualCommentPosition | null {
    const anchor = this.#layout.anchorAt(this.container.scrollTop);
    const entry = anchor ? this.#entries[anchor.index] : undefined;
    return anchor && entry ? { id: entry.id, offset: anchor.offset } : null;
  }

  restorePosition(position: VirtualCommentPosition): boolean {
    const index = this.#entries.findIndex((entry) => entry.id === position.id);
    if (index < 0) return false;
    const nextScrollTop = this.#layout.offsetFor(index) + Math.max(0, position.offset);
    this.#ignoredScrollTop = nextScrollTop;
    this.container.scrollTop = nextScrollTop;
    this.refreshNow(true);
    return true;
  }

  setEntries(entries: readonly VisibleEntry[], estimatedHeights?: readonly number[]): void {
    const anchor = this.#layout.anchorAt(this.container.scrollTop);
    const anchoredEntry = anchor ? this.#entries[anchor.index] : undefined;
    this.#entries = entries;
    // Row indices change when a nested branch opens; measurements belong to entries.
    this.#layout.setCount(0);
    this.#layout.setCount(entries.length);
    for (const [index, entry] of entries.entries()) {
      const height = this.#measuredHeights.get(heightIdentity(entry)) ?? estimatedHeights?.[index];
      if (height !== undefined) this.#layout.updateHeight(index, height);
    }
    if (anchor && anchoredEntry) {
      const nextIndex = entries.findIndex((entry) => (
        entry.id === anchoredEntry.id
      ));
      this.#restoreAnchor(nextIndex >= 0 ? { index: nextIndex, offset: anchor.offset } : anchor);
    }
    this.refreshNow(true);
  }

  scrollToIndex(index: number): void {
    this.#ignoredScrollTop = null;
    this.container.scrollTop = this.#layout.offsetFor(index);
    this.refreshNow(true);
  }

  seedHeights(heights: readonly number[]): void {
    const anchor = this.#layout.anchorAt(this.container.scrollTop);
    this.#layout.seedHeights(heights.map((height, index) => {
      const entry = this.#entries[index];
      return entry ? this.#measuredHeights.get(heightIdentity(entry)) ?? height : height;
    }));
    this.#restoreAnchor(anchor);
    this.refreshNow();
  }

  schedule(notifyViewportChange = false): void {
    this.#notifyViewportChange ||= notifyViewportChange;
    if (this.#paused) { this.#pendingRefresh = true; return; }
    if (this.#frame !== null) return;
    this.#frame = this.#requestFrame(() => {
      this.#frame = null;
      const notify = this.#notifyViewportChange;
      this.#notifyViewportChange = false;
      this.refreshNow(notify);
    });
  }

  refreshNow(notifyViewportChange = false): void {
    if (this.#scope.destroyed) return;
    if (this.#paused) {
      this.#pendingRefresh = true;
      this.#notifyViewportChange ||= notifyViewportChange;
      return;
    }
    const range = this.#layout.range(this.container.scrollTop, this.container.clientHeight || 720);
    const fragment = this.container.ownerDocument.createDocumentFragment();
    const renderedEntries: VisibleEntry[] = [];
    this.#resizeObserver?.disconnect();
    for (let index = range.start; index < range.end; index += 1) {
      const entry = this.#entries[index];
      if (!entry) continue;
      const element = this.renderEntry(entry, index);
      renderedEntries.push(entry);
      element.dataset.virtualIndex = String(index);
      fragment.append(element);
      this.#resizeObserver?.observe(element);
    }
    this.#top.style.height = `${range.topSpacer}px`;
    this.#bottom.style.height = `${range.bottomSpacer}px`;
    this.#items.replaceChildren(fragment);
    this.onRenderedEntries?.(
      Object.freeze(renderedEntries),
      Object.freeze(this.#entries.slice(range.viewportStart, range.viewportEnd)),
      notifyViewportChange,
    );
  }

  destroy(): void {
    this.#scope.destroy();
  }

  setPaused(paused: boolean): void {
    if (this.#scope.destroyed || paused === this.#paused) return;
    this.#paused = paused;
    if (paused) {
      this.#pendingRefresh = true;
      if (this.#frame !== null) this.#cancelFrame(this.#frame);
      this.#frame = null;
      this.#resizeObserver?.disconnect();
    } else if (this.#pendingRefresh) {
      this.#pendingRefresh = false;
      const notify = this.#notifyViewportChange;
      this.#notifyViewportChange = false;
      this.refreshNow(notify);
    }
  }

  #requestFrame(callback: FrameRequestCallback): number {
    const view = this.container.ownerDocument.defaultView;
    return view?.requestAnimationFrame(callback) ?? window.setTimeout(() => callback(performance.now()), 16);
  }

  #cancelFrame(frame: number): void {
    const view = this.container.ownerDocument.defaultView;
    if (view?.cancelAnimationFrame) view.cancelAnimationFrame(frame);
    else clearTimeout(frame);
  }

  #restoreAnchor(anchor: ReturnType<VirtualCommentLayout["anchorAt"]>): void {
    if (!anchor) return;
    const nextScrollTop = this.#layout.offsetFor(anchor.index) + anchor.offset;
    if (Math.abs(this.container.scrollTop - nextScrollTop) > 0.5) {
      this.#ignoredScrollTop = nextScrollTop;
      this.container.scrollTop = nextScrollTop;
    }
  }
}
