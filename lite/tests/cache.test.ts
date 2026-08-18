import { indexedDB } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { CacheRepository } from "../src/cache/cache-repository";
import { MemoryCacheStore } from "../src/cache/cache-store";
import { IndexedDbCacheStore } from "../src/cache/indexeddb-cache-store";

describe("CacheRepository", () => {
  it("expires records and coalesces loads", async () => {
    let now = 1_000;
    const repository = new CacheRepository(new MemoryCacheStore<string>(), () => now);
    await repository.set("short", "value", 10);
    expect(await repository.get("short")).toBe("value");
    now += 11;
    expect(await repository.get("short")).toBeUndefined();

    const loader = vi.fn(() => Promise.resolve("loaded"));
    const values = await Promise.all([
      repository.getOrLoad("shared", loader),
      repository.getOrLoad("shared", loader),
    ]);
    expect(values).toEqual(["loaded", "loaded"]);
    expect(loader).toHaveBeenCalledOnce();
  });

  it("persists and clears IndexedDB records", async () => {
    const store = new IndexedDbCacheStore<string>("hn-reader-test", "cache", indexedDB);
    await store.set({ key: "fresh", value: "ok", expiresAt: 2_000 });
    await store.set({ key: "expired", value: "old", expiresAt: 500 });
    expect((await store.get("fresh"))?.value).toBe("ok");
    expect(await store.clearExpired(1_000)).toBe(1);
    expect(await store.get("expired")).toBeUndefined();
    await store.clear();
    expect(await store.get("fresh")).toBeUndefined();
    await store.close();
  });
});
