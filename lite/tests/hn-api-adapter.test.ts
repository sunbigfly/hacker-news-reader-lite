// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { HnApiAdapter, decodeHnItem } from "../src/hn-api/hn-api-adapter";
import type { HttpClient, RequestDescriptor } from "../src/network/request-contract";

class FakeHttpClient implements HttpClient {
  readonly requested: string[] = [];
  constructor(readonly items: Readonly<Record<number, unknown>>) {}

  request<T>(descriptor: RequestDescriptor<T>): Promise<T> {
    this.requested.push(descriptor.url);
    const id = Number.parseInt(descriptor.url.split("/").at(-1) ?? "", 10);
    return Promise.resolve(descriptor.decode({
      status: 200,
      statusText: "OK",
      headers: {},
      body: JSON.stringify(this.items[id]),
      finalUrl: descriptor.url,
    }));
  }
}

describe("HN API adapter", () => {
  it("accepts only matching item payloads", () => {
    expect(decodeHnItem(JSON.stringify({ id: 1, type: "story", kids: [2] }), 1).kids).toEqual([2]);
    expect(() => decodeHnItem(JSON.stringify({ id: 2, type: "story" }), 1)).toThrow(/did not match/);
  });

  it("loads a complete tree through registered item endpoints", async () => {
    const http = new FakeHttpClient({
      1: { id: 1, type: "story", title: "Story", kids: [2], descendants: 2 },
      2: { id: 2, type: "comment", parent: 1, by: "a", text: "root", kids: [3] },
      3: { id: 3, type: "comment", parent: 2, by: "b", text: "child", kids: [] },
    });
    const adapter = new HnApiAdapter(http);
    const result = await adapter.loadThread(1 as never, document);
    expect(result.comments.map((comment) => [comment.id, comment.parentId])).toEqual([[2, 1], [3, 2]]);
    expect(http.requested).toEqual([
      "https://hacker-news.firebaseio.com/v0/item/1.json",
      "https://hacker-news.firebaseio.com/v0/item/2.json",
      "https://hacker-news.firebaseio.com/v0/item/3.json",
    ]);
  });

  it("loads only newly attached realtime comment subtrees", async () => {
    const http = new FakeHttpClient({
      4: { id: 4, type: "comment", parent: 2, by: "new", time: 10, text: "new reply", kids: [5] },
      5: { id: 5, type: "comment", parent: 4, by: "child", time: 11, text: "new child", kids: [] },
    });
    const adapter = new HnApiAdapter(http);

    const comments = await adapter.loadCommentSubtrees(
      1 as never,
      [{ id: 4 as never, parentId: 2 as never, rank: 1 }],
      document,
    );

    expect(comments.map((comment) => [comment.id, comment.parentId, comment.rank])).toEqual([
      [4, 2, 1],
      [5, 4, 0],
    ]);
    expect(http.requested).toEqual([
      "https://hacker-news.firebaseio.com/v0/item/4.json",
      "https://hacker-news.firebaseio.com/v0/item/5.json",
    ]);
  });

  it("resolves a comment permalink through its parent chain to a Reader target", async () => {
    const http = new FakeHttpClient({
      1: { id: 1, type: "story", title: "Story" },
      2: { id: 2, type: "comment", parent: 1, text: "parent" },
      5: { id: 5, type: "comment", parent: 2, text: "target" },
    });
    const adapter = new HnApiAdapter(http);

    await expect(adapter.resolveReaderTarget(5)).resolves.toEqual({
      storyId: 1,
      commentId: 5,
    });
    expect(http.requested).toEqual([
      "https://hacker-news.firebaseio.com/v0/item/5.json",
      "https://hacker-news.firebaseio.com/v0/item/2.json",
      "https://hacker-news.firebaseio.com/v0/item/1.json",
    ]);
  });

  it("loads only a requested comment and its parent path for Reader location", async () => {
    const http = new FakeHttpClient({
      1: { id: 1, type: "story", title: "Story", kids: [2] },
      2: { id: 2, type: "comment", parent: 1, by: "parent", text: "parent", kids: [5, 6] },
      5: { id: 5, type: "comment", parent: 2, by: "target", text: "target", kids: [] },
      6: { id: 6, type: "comment", parent: 2, by: "sibling", text: "sibling", kids: [] },
    });
    const adapter = new HnApiAdapter(http);

    const comments = await adapter.loadCommentPath(5 as never, 1 as never, document);

    expect(comments.map((comment) => [comment.id, comment.parentId, comment.rank])).toEqual([
      [2, 1, 0],
      [5, 2, 0],
    ]);
    expect(http.requested).toEqual([
      "https://hacker-news.firebaseio.com/v0/item/5.json",
      "https://hacker-news.firebaseio.com/v0/item/2.json",
      "https://hacker-news.firebaseio.com/v0/item/1.json",
    ]);
  });
});
