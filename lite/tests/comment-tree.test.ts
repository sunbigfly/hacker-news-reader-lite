import { describe, expect, it } from "vitest";
import { CommentProjection } from "../src/thread/comment-projection";
import { CommentTree } from "../src/thread/comment-tree";
import type { Comment, Story } from "../src/thread/model";

const story: Story = {
  id: 1 as never,
  title: "story",
  url: null,
  author: "a",
  score: 1,
  html: "",
  childIds: [2 as never, 9 as never],
  descendants: 4,
  observedAt: 1,
};

function comment(id: number, parentId: number, rank: number, childIds: number[] = []): Comment {
  return {
    id: id as never,
    storyId: 1 as never,
    parentId: parentId as never,
    childIds: childIds as never,
    rank,
    author: "u",
    createdAt: null,
    html: String(id),
    text: String(id),
    deleted: false,
    dead: false,
    source: "dom",
    observedAt: 1,
  };
}

describe("CommentTree and projection", () => {
  it("preserves branches, missing nodes, collapse and reveal", () => {
    const tree = new CommentTree(story, [comment(2, 1, 0, [3, 4]), comment(3, 2, 0), comment(4, 2, 1)]);
    expect(tree.missingIds()).toEqual([9]);
    const projection = new CommentProjection(tree);
    expect(projection.entries().map((entry) => entry.id)).toEqual([2, 3, 4, 9]);
    expect(projection.toggle(2 as never)).toBe(true);
    expect(projection.entries().map((entry) => entry.id)).toEqual([2, 9]);
    expect(projection.collapsedIds()).toEqual([2]);
    projection.reveal(4 as never);
    expect(projection.entries().map((entry) => entry.id)).toEqual([2, 3, 4, 9]);
    projection.restoreCollapsed([2 as never, 9 as never]);
    expect(projection.collapsedIds()).toEqual([2, 9]);
    expect(projection.entries().map((entry) => entry.id)).toEqual([2, 9]);
  });

  it("rejects cycles", () => {
    expect(() => new CommentTree(story, [comment(2, 3, 0), comment(3, 2, 0)])).toThrow(/cycle/);
  });

  it("transactionally replaces a cached tree with a fresh page snapshot", () => {
    const tree = new CommentTree(story, [comment(2, 1, 0), comment(9, 1, 1)]);
    const freshStory = { ...story, childIds: [2 as never], observedAt: 2 };
    tree.replace(freshStory, [comment(2, 1, 0, [3]), { ...comment(3, 2, 0), observedAt: 2 }]);
    expect(tree.values().map((entry) => entry.id)).toEqual([2, 3]);
    expect(tree.has(9 as never)).toBe(false);
    expect(() => tree.replace(freshStory, [comment(2, 3, 0), comment(3, 2, 0)])).toThrow(/cycle/);
    expect(tree.values().map((entry) => entry.id)).toEqual([2, 3]);
  });
});
