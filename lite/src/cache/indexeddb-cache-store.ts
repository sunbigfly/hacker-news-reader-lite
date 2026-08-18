import type { CacheRecord, CacheStore } from "./cache-store";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB request failed")), { once: true });
  });
}

export class IndexedDbCacheStore<T> implements CacheStore<T> {
  readonly #databaseName: string;
  readonly #storeName: string;
  readonly #factory: IDBFactory;
  #databasePromise: Promise<IDBDatabase> | undefined;

  constructor(
    databaseName = "hacker-news-reader-lite",
    storeName = "cache-v1",
    factory: IDBFactory = indexedDB,
  ) {
    this.#databaseName = databaseName;
    this.#storeName = storeName;
    this.#factory = factory;
  }

  async get(key: string): Promise<CacheRecord<T> | undefined> {
    return this.#transaction("readonly", async (store) => {
      const value: unknown = await requestResult<unknown>(store.get(key));
      return value as CacheRecord<T> | undefined;
    });
  }

  async set(record: CacheRecord<T>): Promise<void> {
    await this.#transaction("readwrite", async (store) => {
      await requestResult(store.put(record));
    });
  }

  async delete(key: string): Promise<void> {
    await this.#transaction("readwrite", async (store) => {
      await requestResult(store.delete(key));
    });
  }

  async clear(): Promise<void> {
    await this.#transaction("readwrite", async (store) => {
      await requestResult(store.clear());
    });
  }

  async clearExpired(now = Date.now()): Promise<number> {
    return this.#transaction("readwrite", (store) => new Promise<number>((resolve, reject) => {
      let removed = 0;
      const request = store.openCursor();
      request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB cursor failed")), { once: true });
      request.addEventListener("success", () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(removed);
          return;
        }
        const record = cursor.value as CacheRecord<T>;
        if (record.expiresAt <= now) {
          const deletion = cursor.delete();
          deletion.addEventListener("success", () => {
            removed += 1;
            cursor.continue();
          }, { once: true });
          deletion.addEventListener("error", () => reject(deletion.error ?? new Error("IndexedDB delete failed")), { once: true });
        } else {
          cursor.continue();
        }
      });
    }));
  }

  async close(): Promise<void> {
    const pending = this.#databasePromise;
    this.#databasePromise = undefined;
    if (pending) (await pending).close();
  }

  async #database(): Promise<IDBDatabase> {
    this.#databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.#factory.open(this.#databaseName, 1);
      request.addEventListener("upgradeneeded", () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(this.#storeName)) {
          database.createObjectStore(this.#storeName, { keyPath: "key" });
        }
      });
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error ?? new Error("IndexedDB open failed")), { once: true });
      request.addEventListener("blocked", () => reject(new Error("IndexedDB open was blocked")), { once: true });
    });
    return this.#databasePromise;
  }

  async #transaction<R>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => Promise<R>,
  ): Promise<R> {
    const database = await this.#database();
    const transaction = database.transaction(this.#storeName, mode);
    const completion = new Promise<void>((resolve, reject) => {
      transaction.addEventListener("complete", () => resolve(), { once: true });
      transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IndexedDB transaction aborted")), { once: true });
      transaction.addEventListener("error", () => reject(transaction.error ?? new Error("IndexedDB transaction failed")), { once: true });
    });
    const result = await operation(transaction.objectStore(this.#storeName));
    await completion;
    return result;
  }
}
