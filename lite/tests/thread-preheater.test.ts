// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { ThreadPreheater, type IdleBudget, type PreheatIdleScheduler } from "../src/thread/thread-preheater";
import type { Comment, Story, ThreadSnapshot } from "../src/thread/model";

class IdleQueue implements PreheatIdleScheduler {
  readonly pending = new Map<number, (budget: IdleBudget) => void>();
  calls = 0;
  #next = 1;

  schedule(callback: (budget: IdleBudget) => void): number {
    const id = this.#next++;
    this.pending.set(id, callback);
    return id;
  }

  cancel(handle: number): void { this.pending.delete(handle); }

  flushAll(): void {
    while (this.pending.size > 0) {
      const [id, callback] = this.pending.entries().next().value as [number, (budget: IdleBudget) => void];
      this.pending.delete(id);
      this.calls += 1;
      callback({ timeRemaining: () => 10 });
    }
  }
}

function fixture(count: number): ThreadSnapshot {
  const story: Story = {
    id: 1 as never, title: "large", url: null, author: "a", score: 1, html: "",
    childIds: count > 0 ? [2 as never] : [], descendants: count, observedAt: 1,
  };
  const comments: Comment[] = Array.from({ length: count }, (_, index) => {
    const id = index + 2;
    return {
      id: id as never,
      storyId: 1 as never,
      parentId: index === 0 ? 1 as never : (id - 1) as never,
      childIds: index + 1 < count ? [(id + 1) as never] : [],
      rank: index,
      author: `user-${index}`,
      createdAt: null,
      html: `<p>This is comment ${index} with enough text to translate.</p>`,
      text: `This is comment ${index} with enough text to translate.`,
      deleted: false, dead: false, source: "dom", observedAt: 1,
    };
  });
  return {
    schemaVersion: 1, story, comments, loadedIds: comments.map((item) => item.id), missingIds: [], complete: true, capturedAt: 1,
  };
}

describe("ThreadPreheater", () => {
  it("preheats all 1000 comments in bounded idle slices", () => {
    const queue = new IdleQueue();
    const preheater = new ThreadPreheater(document, queue);
    const progress: number[] = [];
    preheater.start(fixture(1_000), (complete) => progress.push(complete));
    expect(preheater.size).toBe(0);
    queue.flushAll();
    expect(preheater.size).toBe(1_000);
    expect(queue.calls).toBeGreaterThanOrEqual(32);
    expect(progress.at(-1)).toBe(1_000);
    expect(preheater.get(2 as never)).toMatchObject({ depth: 0, needsTranslation: true });
    expect(preheater.get(1_001 as never)?.depth).toBe(999);
    expect(preheater.get(2 as never)?.searchText).toContain("user-0");
    preheater.destroy();
    expect(preheater.size).toBe(0);
  });

  it("cancels a pending generation before it touches the DOM", () => {
    const queue = new IdleQueue();
    const preheater = new ThreadPreheater(document, queue);
    preheater.start(fixture(20));
    expect(queue.pending.size).toBe(1);
    preheater.cancel();
    queue.flushAll();
    expect(preheater.size).toBe(0);
  });

  it("drops comments removed by a fresh snapshot", () => {
    const queue = new IdleQueue();
    const preheater = new ThreadPreheater(document, queue);
    preheater.start(fixture(3));
    queue.flushAll();
    expect(preheater.size).toBe(3);

    const smaller = fixture(2);
    preheater.start({ ...smaller, comments: smaller.comments.slice(1) });
    queue.flushAll();
    expect(preheater.size).toBe(1);
    expect(preheater.get(2 as never)).toBeUndefined();
    preheater.destroy();
  });
});
