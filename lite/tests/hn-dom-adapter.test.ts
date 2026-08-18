// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseHnDocument, parseHnStoryPreview } from "../src/host/hn-dom-adapter";

describe("HN DOM adapter", () => {
  it("preserves order and parent relationships in a lightweight DOM snapshot", () => {
    document.documentElement.innerHTML = readFileSync(resolve("lite/fixtures/hn-item.html"), "utf8");
    const snapshot = parseHnDocument(document, 1234);
    expect(snapshot.story.id).toBe(100);
    expect(snapshot.story.childIds).toEqual([101, 104]);
    expect(snapshot.comments.map((comment) => [comment.id, comment.parentId, comment.rank])).toEqual([
      [101, 100, 0],
      [102, 101, 0],
      [103, 102, 0],
      [104, 100, 1],
    ]);
    expect(snapshot.comments[0]?.html).toContain("item?id=100");
    expect(snapshot.comments[2]?.html).toContain("script");
    expect(snapshot.comments[3]?.deleted).toBe(true);
  });

  it("builds an immediate list preview and caps the optimistic comment projection", () => {
    document.documentElement.innerHTML = `
      <head><base href="https://news.ycombinator.com/news"></head>
      <body><table>
        <tr class="athing" id="42"><td class="title"><span class="titleline"><a href="https://example.com/story">Story</a></span></td></tr>
        <tr><td class="subtext"><span class="score">12 points</span> by <a class="hnuser">alice</a> | <a class="comments">80 comments</a></td></tr>
      </table></body>`;
    const preview = parseHnStoryPreview(document, 42 as never, 1_000);
    expect(preview?.story).toMatchObject({ id: 42, title: "Story", descendants: 80 });
    expect(preview?.comments).toHaveLength(0);
    expect(preview?.complete).toBe(false);

    document.documentElement.innerHTML = readFileSync(resolve("lite/fixtures/hn-item.html"), "utf8");
    const optimistic = parseHnDocument(document, 1_000, 2);
    expect(optimistic.comments.map((comment) => comment.id)).toEqual([101, 102]);
    expect(optimistic.story.childIds).toEqual([101]);
    expect(optimistic.complete).toBe(false);
  });
});
