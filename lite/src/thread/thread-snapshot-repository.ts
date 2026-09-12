import { CacheRepository, DEFAULT_CACHE_TTL_MS } from "../cache/cache-repository";
import type { CacheStore } from "../cache/cache-store";
import { IndexedDbCacheStore } from "../cache/indexeddb-cache-store";
import { CommentTree } from "./comment-tree";
import type { Comment, CommentId, ItemId, Story, StoryId, ThreadSnapshot } from "./model";

interface CloseableCacheStore<T> extends CacheStore<T> {
  close?(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function nullableInteger(value: unknown): value is number | null {
  return value === null || isNonNegativeInteger(value);
}

function itemIds(value: unknown): readonly CommentId[] | null {
  if (!Array.isArray(value) || !value.every(isPositiveInteger)) return null;
  return Object.freeze(value.map((id) => id as CommentId));
}

function restoreStory(value: unknown, expectedId: StoryId): Story | null {
  if (!isRecord(value) || value.id !== expectedId) return null;
  const childIds = itemIds(value.childIds);
  if (
    childIds === null
    || typeof value.title !== "string"
    || !nullableString(value.url)
    || !nullableString(value.author)
    || !nullableInteger(value.score)
    || typeof value.html !== "string"
    || !nullableInteger(value.descendants)
    || !isFiniteNumber(value.observedAt)
  ) return null;
  return Object.freeze({
    id: expectedId,
    title: value.title,
    url: value.url,
    author: value.author,
    score: value.score,
    html: value.html,
    childIds,
    descendants: value.descendants,
    observedAt: value.observedAt,
  });
}

function restoreComment(value: unknown, storyId: StoryId): Comment | null {
  if (!isRecord(value) || !isPositiveInteger(value.id) || value.storyId !== storyId) return null;
  if (!isPositiveInteger(value.parentId)) return null;
  const childIds = itemIds(value.childIds);
  if (
    childIds === null
    || !isNonNegativeInteger(value.rank)
    || !nullableString(value.author)
    || !(value.createdAt === null || isFiniteNumber(value.createdAt))
    || typeof value.html !== "string"
    || typeof value.text !== "string"
    || typeof value.deleted !== "boolean"
    || typeof value.dead !== "boolean"
    || !isFiniteNumber(value.observedAt)
  ) return null;
  return Object.freeze({
    id: value.id as CommentId,
    storyId,
    parentId: value.parentId as ItemId,
    childIds,
    rank: value.rank,
    author: value.author,
    createdAt: value.createdAt,
    html: value.html,
    text: value.text,
    deleted: value.deleted,
    dead: value.dead,
    source: "cache",
    observedAt: value.observedAt,
  });
}

export function restoreThreadSnapshot(
  value: unknown,
  expectedId: StoryId,
  commentLimit = Number.POSITIVE_INFINITY,
): ThreadSnapshot | undefined {
  if (!(commentLimit === Number.POSITIVE_INFINITY || (Number.isSafeInteger(commentLimit) && commentLimit > 0))) {
    throw new RangeError("comment limit must be a positive integer");
  }
  if (
    !isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.complete !== "boolean"
    || !isFiniteNumber(value.capturedAt)
    || !Array.isArray(value.comments)
  ) return undefined;
  const story = restoreStory(value.story, expectedId);
  if (!story) return undefined;
  const comments: Comment[] = [];
  const seen = new Set<CommentId>();
  for (const rawComment of value.comments.slice(0, commentLimit)) {
    const comment = restoreComment(rawComment, expectedId);
    if (!comment || seen.has(comment.id)) return undefined;
    comments.push(comment);
    seen.add(comment.id);
  }
  try {
    const loadedIds = new Set(comments.map((comment) => comment.id));
    const restoredAllComments = comments.length === value.comments.length;
    const optimisticStory = {
      ...story,
      childIds: restoredAllComments ? story.childIds : Object.freeze(story.childIds.filter((id) => loadedIds.has(id))),
    };
    const optimisticComments = comments.map((comment) => Object.freeze({
      ...comment,
      childIds: restoredAllComments ? comment.childIds : Object.freeze(comment.childIds.filter((id) => loadedIds.has(id))),
    }));
    return new CommentTree(optimisticStory, optimisticComments).snapshot(
      restoredAllComments && value.complete,
      value.capturedAt,
    );
  } catch {
    return undefined;
  }
}

export interface OptimisticThreadSnapshot {
  readonly initial: ThreadSnapshot;
  readonly complete: () => Promise<ThreadSnapshot | undefined>;
}

function cacheKey(storyId: StoryId): string {
  return `thread:v1:${storyId}`;
}

/** Persists validated canonical thread snapshots for instant Reader warm starts. */
export class ThreadSnapshotRepository {
  readonly #store: CloseableCacheStore<unknown>;
  readonly #cache: CacheRepository<unknown>;

  constructor(
    store: CloseableCacheStore<unknown> = new IndexedDbCacheStore<unknown>(
      "hacker-news-reader-threads",
      "cache-v1",
    ),
    now: () => number = Date.now,
  ) {
    this.#store = store;
    this.#cache = new CacheRepository(store, now);
  }

  async get(storyId: StoryId): Promise<ThreadSnapshot | undefined> {
    const key = cacheKey(storyId);
    const cached = await this.#cache.get(key);
    if (cached === undefined) return undefined;
    const snapshot = restoreThreadSnapshot(cached, storyId);
    if (snapshot) return snapshot;
    await this.#cache.delete(key);
    return undefined;
  }

  async getOptimistic(storyId: StoryId, commentLimit: number): Promise<OptimisticThreadSnapshot | undefined> {
    const key = cacheKey(storyId);
    const cached = await this.#cache.get(key);
    if (cached === undefined) return undefined;
    const initial = restoreThreadSnapshot(cached, storyId, commentLimit);
    if (!initial) {
      await this.#cache.delete(key);
      return undefined;
    }
    return Object.freeze({
      initial,
      complete: async () => {
        const snapshot = restoreThreadSnapshot(cached, storyId);
        if (snapshot) return snapshot;
        await this.#cache.delete(key);
        return undefined;
      },
    });
  }

  async set(snapshot: ThreadSnapshot): Promise<void> {
    const restored = restoreThreadSnapshot(snapshot, snapshot.story.id);
    if (!restored) throw new TypeError("thread snapshot is invalid");
    await this.#cache.set(cacheKey(snapshot.story.id), restored, DEFAULT_CACHE_TTL_MS);
  }

  clear(): Promise<void> {
    return this.#cache.clear();
  }

  async close(): Promise<void> {
    await this.#store.close?.();
  }
}
