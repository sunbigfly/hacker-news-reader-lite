// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MemoryCacheStore } from "../src/cache/cache-store";
import { parseHnDocument } from "../src/host/hn-dom-adapter";
import { ThreadSnapshotRepository } from "../src/thread/thread-snapshot-repository";

describe("ThreadSnapshotRepository", () => {
  it("restores a validated canonical cache snapshot and rejects corrupt data", async () => {
    const source = new DOMParser().parseFromString(
      readFileSync(resolve("lite/fixtures/hn-item.html"), "utf8"),
      "text/html",
    );
    const snapshot = parseHnDocument(source, 1_000);
    const store = new MemoryCacheStore<unknown>();
    const repository = new ThreadSnapshotRepository(store, () => 2_000);
    await repository.set(snapshot);

    const restored = await repository.get(snapshot.story.id);
    expect(restored?.story.id).toBe(100);
    expect(restored?.comments).toHaveLength(4);
    expect(restored?.comments.every((comment) => comment.source === "cache")).toBe(true);

    const optimistic = await repository.getOptimistic(snapshot.story.id, 2);
    expect(optimistic?.initial.comments.map((comment) => comment.id)).toEqual([101, 102]);
    expect(optimistic?.initial.story.childIds).toEqual([101]);
    expect(optimistic?.initial.complete).toBe(false);
    expect((await optimistic?.complete())?.comments).toHaveLength(4);

    await repository.clear();
    await store.set({
      key: "thread:v1:100",
      value: { ...snapshot, comments: [{ id: -1 }] },
      expiresAt: 5_000,
    });
    expect(await repository.get(snapshot.story.id)).toBeUndefined();
    expect(await store.get("thread:v1:100")).toBeUndefined();
  });
});
