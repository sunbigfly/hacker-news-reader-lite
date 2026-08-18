import type { CacheRecord, CacheStore } from "./cache-store";

export const DEFAULT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export class CacheRepository<T> {
  readonly #memory = new Map<string, CacheRecord<T>>();
  readonly #inflight = new Map<string, Promise<T>>();

  constructor(
    readonly store: CacheStore<T>,
    readonly now: () => number = Date.now,
  ) {}

  async get(key: string): Promise<T | undefined> {
    const now = this.now();
    const memory = this.#memory.get(key);
    if (memory) {
      if (memory.expiresAt > now) return memory.value;
      this.#memory.delete(key);
    }
    const stored = await this.store.get(key);
    if (!stored) return undefined;
    if (stored.expiresAt <= now) {
      await this.store.delete(key);
      return undefined;
    }
    this.#memory.set(key, stored);
    return stored.value;
  }

  async set(key: string, value: T, ttlMs = DEFAULT_CACHE_TTL_MS): Promise<void> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError("cache ttl must be positive");
    const record: CacheRecord<T> = { key, value, expiresAt: this.now() + ttlMs };
    this.#memory.set(key, record);
    await this.store.set(record);
  }

  async getOrLoad(key: string, loader: () => Promise<T>, ttlMs = DEFAULT_CACHE_TTL_MS): Promise<T> {
    const cached = await this.get(key);
    if (cached !== undefined) return cached;
    const existing = this.#inflight.get(key);
    if (existing) return existing;
    const loading = loader().then(async (value) => {
      await this.set(key, value, ttlMs);
      return value;
    }).finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, loading);
    return loading;
  }

  async delete(key: string): Promise<void> {
    this.#memory.delete(key);
    await this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.#memory.clear();
    this.#inflight.clear();
    await this.store.clear();
  }
}
