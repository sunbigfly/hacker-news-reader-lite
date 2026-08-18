// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import type { VisibleEntry } from "../src/thread/comment-projection";
import { VirtualCommentList } from "../src/stream/virtual-comment-list";

describe("VirtualCommentList", () => {
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
