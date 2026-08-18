export interface CacheRecord<T> {
  readonly key: string;
  readonly value: T;
  readonly expiresAt: number;
}

export interface CacheStore<T> {
  get(key: string): Promise<CacheRecord<T> | undefined>;
  set(record: CacheRecord<T>): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  clearExpired(now?: number): Promise<number>;
}

export class MemoryCacheStore<T> implements CacheStore<T> {
  readonly #records = new Map<string, CacheRecord<T>>();

  get(key: string): Promise<CacheRecord<T> | undefined> {
    return Promise.resolve(this.#records.get(key));
  }

  set(record: CacheRecord<T>): Promise<void> {
    this.#records.set(record.key, record);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.#records.delete(key);
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.#records.clear();
    return Promise.resolve();
  }

  clearExpired(now = Date.now()): Promise<number> {
    let removed = 0;
    for (const [key, record] of this.#records) {
      if (record.expiresAt <= now) {
        this.#records.delete(key);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }
}
