// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { VisibleEntry } from "../src/thread/comment-projection";
import { VirtualCommentList } from "../src/stream/virtual-comment-list";
import { VirtualCommentLayout } from "../src/stream/virtual-comment-layout";

describe("VirtualCommentList", () => {
  it("keeps measured heights with their comments across repeated nested reply expansion", () => {
    let resize: ResizeObserverCallback | undefined;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe(): void {}
      disconnect(): void {}
    });
    const container = document.createElement("div");
    const layout = new VirtualCommentLayout();
    const list = new VirtualCommentList(container, () => document.createElement("article"), undefined, layout);
    const comment = (id: number, depth: number): VisibleEntry => ({
      kind: "comment", id: id as never, depth, collapsed: false, hasChildren: true,
    });
    const parent = comment(2, 0);
    const nested = comment(3, 1);
    const sibling = comment(20, 0);
    const folded: VisibleEntry = {
      kind: "replies", id: 4 as never, parentId: 3 as never, depth: 2,
      remainingCount: 2, countExact: true, shownCount: 0,
    };
    const measure = (heights: number[]): void => {
      const rows = [...container.querySelectorAll<HTMLElement>("[data-virtual-index]")];
      resize?.(rows.map((target, index) => ({
        target, contentRect: new DOMRect(0, 0, 800, heights[index] ?? 112),
        borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [],
      })), {} as ResizeObserver);
    };
    try {
      list.setEntries([parent, nested, folded, sibling]);
      measure([400, 240, 48, 800]);
      const staleRows = [...container.querySelectorAll<HTMLElement>("[data-virtual-index]")];
      list.setEntries([parent, nested, comment(4, 2), comment(5, 2), sibling], [112, 112, 112, 112, 112]);
      expect(layout.offsetFor(2)).toBe(640);
      expect(layout.offsetFor(3) - layout.offsetFor(2)).toBe(112);
      measure([400, 240, 120, 180, 800]);
      for (let cycle = 0; cycle < 2; cycle += 1) {
        list.setEntries([parent, nested, folded, sibling]);
        expect(layout.offsetFor(3)).toBe(688);
        list.setEntries([parent, nested, comment(4, 2), comment(5, 2), sibling]);
        expect(layout.offsetFor(4)).toBe(940);
      }
      const staleTarget = staleRows[2];
      if (!staleTarget) throw new Error("Missing folded reply row");
      resize?.([{
        target: staleTarget, contentRect: new DOMRect(0, 0, 800, 48),
        borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [],
      }], {} as ResizeObserver);
      expect(layout.offsetFor(4)).toBe(940);
    } finally {
      list.destroy();
      vi.unstubAllGlobals();
    }
  });

  it("mounts a bounded window and fully cleans up", () => {
    const container = document.createElement("div");
    Object.defineProperty(container, "clientHeight", { value: 800 });
    document.body.append(container);
    const entries: VisibleEntry[] = Array.from({ length: 1_000 }, (_, index) => ({
      kind: "comment" as const,
      id: (index + 1) as never,
      depth: index,
      collapsed: false,
      hasChildren: index < 999,
    }));
    const list = new VirtualCommentList(container, (entry) => {
      const row = document.createElement("article");
      row.dataset.commentId = String(entry.id);
      return row;
    });
    list.setEntries(entries);
    expect(list.mountedCount).toBeLessThanOrEqual(120);
    container.scrollTop = 80_000;
    list.refreshNow();
    expect(list.mountedCount).toBeLessThanOrEqual(120);
    list.destroy();
    expect(container.childElementCount).toBe(0);
  });

  it("preserves the visible anchor when preheated heights replace estimates", () => {
    const container = document.createElement("div");
    Object.defineProperty(container, "clientHeight", { value: 400 });
    document.body.append(container);
    const entries: VisibleEntry[] = Array.from({ length: 10 }, (_, index) => ({
      kind: "comment" as const,
      id: (index + 1) as never,
      depth: 0,
      collapsed: false,
      hasChildren: false,
    }));
    const list = new VirtualCommentList(container, () => document.createElement("article"));
    list.setEntries(entries);
    container.scrollTop = 5 * 112 + 24;
    list.seedHeights(Array.from({ length: 10 }, () => 200));
    expect(container.scrollTop).toBe(5 * 200 + 24);
    list.destroy();
  });

  it("preserves the same visible comment when a refreshed snapshot inserts earlier comments", () => {
    const container = document.createElement("div");
    Object.defineProperty(container, "clientHeight", { value: 400 });
    document.body.append(container);
    const entries: VisibleEntry[] = Array.from({ length: 10 }, (_, index) => ({
      kind: "comment" as const,
      id: (index + 1) as never,
      depth: 0,
      collapsed: false,
      hasChildren: false,
    }));
    const list = new VirtualCommentList(container, () => document.createElement("article"));
    list.setEntries(entries);
    container.scrollTop = 5 * 112 + 24;
    list.setEntries([{
      kind: "comment",
      id: 99 as never,
      depth: 0,
      collapsed: false,
      hasChildren: false,
    }, ...entries]);
    expect(container.scrollTop).toBe(6 * 112 + 24);
    list.destroy();
  });

  it("captures and restores the same physical offset inside a comment", () => {
    const container = document.createElement("div");
    Object.defineProperty(container, "clientHeight", { value: 400 });
    document.body.append(container);
    const entries: VisibleEntry[] = Array.from({ length: 20 }, (_, index) => ({
      kind: "comment" as const,
      id: (index + 1) as never,
      depth: 0,
      collapsed: false,
      hasChildren: false,
    }));
    const first = new VirtualCommentList(container, () => document.createElement("article"));
    first.setEntries(entries);
    container.scrollTop = 8 * 112 + 43;
    const position = first.capturePosition();
    expect(position).toEqual({ id: 9, offset: 43 });
    first.destroy();

    const restored = new VirtualCommentList(container, () => document.createElement("article"));
    const firstEntry = entries[0];
    if (!firstEntry) throw new Error("virtual entries were not created");
    restored.setEntries([{ ...firstEntry, id: 99 as never }, ...entries]);
    expect(position && restored.restorePosition(position)).toBe(true);
    expect(container.scrollTop).toBe(9 * 112 + 43);
    restored.destroy();
  });

  it("reports the true viewport separately from overscan and ignores height-only viewport changes", () => {
    const container = document.createElement("div");
    Object.defineProperty(container, "clientHeight", { value: 400 });
    document.body.append(container);
    const entries: VisibleEntry[] = Array.from({ length: 30 }, (_, index) => ({
      kind: "comment" as const, id: (index + 1) as never, depth: 0, collapsed: false, hasChildren: false,
    }));
    const onRendered = vi.fn();
    const list = new VirtualCommentList(container, () => document.createElement("article"), undefined, undefined, onRendered);
    list.setEntries(entries);
    expect(onRendered).toHaveBeenCalled();
    const initial = onRendered.mock.calls.at(-1);
    expect((initial?.[0] as VisibleEntry[]).length).toBeGreaterThan((initial?.[1] as VisibleEntry[]).length);
    expect((initial?.[1] as VisibleEntry[]).map((entry) => entry.id)).toEqual([1, 2, 3, 4]);
    expect(initial?.[2]).toBe(true);

    list.seedHeights(Array.from({ length: entries.length }, () => 160));
    expect(onRendered.mock.calls.at(-1)?.[2]).toBe(false);
    list.destroy();
  });
});
