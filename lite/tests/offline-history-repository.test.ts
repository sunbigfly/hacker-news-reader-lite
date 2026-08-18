import { describe, expect, it } from "vitest";
import { CacheRepository } from "../src/cache/cache-repository";
import { MemoryCacheStore } from "../src/cache/cache-store";
import {
  OfflineHistoryRepository,
  type CachedOfflineDownload,
} from "../src/offline/offline-history-repository";

describe("OfflineHistoryRepository", () => {
  it("stores completed HTML globally, deduplicates it, and expires it after 30 days", async () => {
    let now = Date.UTC(2026, 7, 17, 8);
    const repository = new OfflineHistoryRepository(
      new CacheRepository<CachedOfflineDownload>(new MemoryCacheStore(), () => now),
      () => now,
    );
    const first = await repository.save({
      storyId: 1 as never,
      storyTitle: "First story",
      filename: "first.html",
      html: "<!doctype html><title>first</title>",
      commentCount: 12,
      translatedCount: 9,
    });
    now += 1_000;
    await repository.save({
      storyId: 2 as never,
      storyTitle: "Second story",
      filename: "second.html",
      html: "<!doctype html><title>second</title>",
      commentCount: 20,
      translatedCount: 20,
    });

    expect((await repository.list()).map((entry) => entry.storyTitle)).toEqual(["Second story", "First story"]);
    expect(await repository.getHtml(first.id)).toContain("<title>first</title>");

    now += 1_000;
    const repeated = await repository.save({
      storyId: 1 as never,
      storyTitle: "First story",
      filename: "first.html",
      html: "<!doctype html><title>first</title>",
      commentCount: 12,
      translatedCount: 9,
    });
    expect(repeated.id).toBe(first.id);
    expect((await repository.list()).map((entry) => entry.storyTitle)).toEqual(["First story", "Second story"]);

    expect(await repository.delete(first.id)).toBe(true);
    expect((await repository.list()).map((entry) => entry.storyTitle)).toEqual(["Second story"]);
    expect(await repository.getHtml(first.id)).toBeUndefined();
    expect(await repository.delete(first.id)).toBe(false);

    now += 30 * 24 * 60 * 60 * 1_000 + 1;
    expect(await repository.list()).toEqual([]);
    expect(await repository.getHtml(first.id)).toBeUndefined();
  });

  it("keeps at most twenty HTML artifacts", async () => {
    let now = 1_000;
    const repository = new OfflineHistoryRepository(
      new CacheRepository<CachedOfflineDownload>(new MemoryCacheStore(), () => now),
      () => now,
    );
    let firstId = "";
    for (let index = 0; index < 21; index += 1) {
      const entry = await repository.save({
        storyId: (index + 1) as never,
        storyTitle: `Story ${index + 1}`,
        filename: `story-${index + 1}.html`,
        html: `<!doctype html><title>${index + 1}</title>`,
        commentCount: index,
        translatedCount: index,
      });
      if (index === 0) firstId = entry.id;
      now += 1;
    }

    expect(await repository.list()).toHaveLength(20);
    expect(await repository.getHtml(firstId)).toBeUndefined();
  });
});
