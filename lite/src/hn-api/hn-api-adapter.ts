import type { CacheRepository } from "../cache/cache-repository";
import type { HttpClient, RequestDescriptor } from "../network/request-contract";
import { sanitizeHtml, textFromHtml } from "../security/sanitize-html";
import {
  commentId,
  storyId,
  type Comment,
  type CommentId,
  type ItemId,
  type Story,
  type StoryId,
} from "../thread/model";

export interface HnItem {
  readonly id: number;
  readonly type: "story" | "comment" | "job" | "poll" | "pollopt";
  readonly by: string | null;
  readonly time: number | null;
  readonly text: string;
  readonly parent: number | null;
  readonly kids: readonly number[];
  readonly deleted: boolean;
  readonly dead: boolean;
  readonly url: string | null;
  readonly title: string;
  readonly score: number | null;
  readonly descendants: number | null;
}

export interface HnReaderTarget {
  readonly storyId: StoryId;
  readonly commentId?: CommentId;
}

export interface HnCommentRoot {
  readonly id: CommentId;
  readonly parentId: ItemId;
  readonly rank: number;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function decodeHnItem(body: string, expectedId: number): HnItem {
  const value = JSON.parse(body) as unknown;
  if (!value || typeof value !== "object") throw new Error("HN item response was empty");
  const record = value as Record<string, unknown>;
  if (record.id !== expectedId) throw new Error("HN item id did not match request");
  const type = record.type;
  if (type !== "story" && type !== "comment" && type !== "job" && type !== "poll" && type !== "pollopt") {
    throw new Error("HN item type was invalid");
  }
  const kids = Array.isArray(record.kids)
    ? record.kids.filter((id): id is number => Number.isSafeInteger(id) && id > 0)
    : [];
  return {
    id: expectedId,
    type,
    by: optionalString(record.by),
    time: optionalNumber(record.time),
    text: optionalString(record.text) ?? "",
    parent: optionalNumber(record.parent),
    kids: Object.freeze(kids),
    deleted: record.deleted === true,
    dead: record.dead === true,
    url: optionalString(record.url),
    title: optionalString(record.title) ?? "",
    score: optionalNumber(record.score),
    descendants: optionalNumber(record.descendants),
  };
}

function itemDescriptor(id: number): RequestDescriptor<HnItem> {
  const url = `https://hacker-news.firebaseio.com/v0/item/${id}.json`;
  return {
    key: `hn:item:${id}`,
    lane: "hn-supplement",
    method: "GET",
    url,
    timeoutMs: 15_000,
    anonymous: true,
    decode: (response) => decodeHnItem(response.body, id),
  };
}

export class HnApiAdapter {
  constructor(
    readonly http: HttpClient,
    readonly cache?: CacheRepository<HnItem>,
  ) {}

  async getItem(id: number, signal?: AbortSignal, fresh = false): Promise<HnItem> {
    const descriptor = itemDescriptor(id);
    if (fresh || !this.cache) {
      const value = await this.http.request(descriptor, signal);
      if (this.cache) await this.cache.set(descriptor.key, value, 5 * 60_000);
      return value;
    }
    return this.cache.getOrLoad(descriptor.key, async () => this.http.request(descriptor, signal), 5 * 60_000);
  }

  async resolveReaderTarget(itemId: number, signal?: AbortSignal): Promise<HnReaderTarget> {
    if (!Number.isSafeInteger(itemId) || itemId <= 0) throw new TypeError("HN item id must be a positive safe integer");
    const visited = new Set<number>();
    let item = await this.getItem(itemId, signal);
    const targetCommentId = item.type === "comment" ? commentId(itemId) : undefined;
    for (let depth = 0; depth < 256; depth += 1) {
      if (signal?.aborted) throw signal.reason;
      if (visited.has(item.id)) throw new Error("HN item parent chain contained a cycle");
      visited.add(item.id);
      if (item.type === "story") {
        return targetCommentId === undefined
          ? { storyId: storyId(item.id) }
          : { storyId: storyId(item.id), commentId: targetCommentId };
      }
      if (item.type !== "comment" || !Number.isSafeInteger(item.parent) || (item.parent ?? 0) <= 0) {
        throw new Error(`HN item ${item.id} cannot be opened as a discussion`);
      }
      item = await this.getItem(item.parent as number, signal);
    }
    throw new Error("HN item parent chain exceeded the 256-item safety limit");
  }

  async loadCommentPath(
    targetId: CommentId,
    expectedStoryId: StoryId,
    document: Document,
    signal?: AbortSignal,
  ): Promise<readonly Comment[]> {
    const visited = new Set<number>();
    const lineage: HnItem[] = [];
    const parents = new Map<number, HnItem>();
    let item = await this.getItem(targetId, signal, true);
    for (let depth = 0; depth < 256; depth += 1) {
      if (signal?.aborted) throw signal.reason;
      if (visited.has(item.id)) throw new Error("HN item parent chain contained a cycle");
      visited.add(item.id);
      if (item.type !== "comment" || !Number.isSafeInteger(item.parent) || (item.parent ?? 0) <= 0) {
        throw new Error(`HN item ${item.id} is not a locatable comment`);
      }
      lineage.push(item);
      const parent = await this.getItem(item.parent as number, signal, true);
      parents.set(item.id, parent);
      if (parent.type === "story") {
        if (parent.id !== expectedStoryId) throw new Error(`HN comment ${targetId} belongs to another discussion`);
        const observedAt = Date.now();
        return Object.freeze(lineage.reverse().map((commentItem) => {
          const parentItem = parents.get(commentItem.id);
          if (!parentItem || commentItem.parent === null) throw new Error(`HN comment ${commentItem.id} parent was unavailable`);
          const knownRank = parentItem.kids.indexOf(commentItem.id);
          return this.toComment(
            commentItem,
            expectedStoryId,
            commentItem.parent as ItemId,
            knownRank >= 0 ? knownRank : parentItem.kids.length,
            document,
            observedAt,
          );
        }));
      }
      if (parent.type !== "comment") throw new Error(`HN item ${parent.id} cannot parent comment ${item.id}`);
      item = parent;
    }
    throw new Error("HN comment parent chain exceeded the 256-item safety limit");
  }

  toStory(item: HnItem, document: Document, observedAt = Date.now()): Story {
    if (item.type !== "story") throw new Error("HN item was not a story");
    const id = storyId(item.id);
    return {
      id,
      title: item.title || `HN item ${item.id}`,
      url: item.url,
      author: item.by,
      score: item.score,
      html: sanitizeHtml(item.text, document, "https://news.ycombinator.com/"),
      childIds: Object.freeze(item.kids.map(commentId)),
      descendants: item.descendants,
      observedAt,
    };
  }

  toComment(
    item: HnItem,
    story: StoryId,
    parentId: ItemId,
    rank: number,
    document: Document,
    observedAt = Date.now(),
  ): Comment {
    if (item.type !== "comment") throw new Error("HN item was not a comment");
    const html = sanitizeHtml(item.text, document, "https://news.ycombinator.com/");
    return {
      id: commentId(item.id),
      storyId: story,
      parentId,
      childIds: Object.freeze(item.kids.map(commentId)),
      rank,
      author: item.by,
      createdAt: item.time === null ? null : item.time * 1_000,
      html,
      text: textFromHtml(html, document),
      deleted: item.deleted,
      dead: item.dead,
      source: "api",
      observedAt,
    };
  }

  async loadThread(
    story: StoryId,
    document: Document,
    signal?: AbortSignal,
    onProgress?: (loaded: number, totalKnown: number) => void,
  ): Promise<{ story: Story; comments: readonly Comment[] }> {
    const storyItem = await this.getItem(story, signal, true);
    const storyModel = this.toStory(storyItem, document);
    const comments = await this.loadCommentSubtrees(
      storyModel.id,
      storyModel.childIds.map((id, rank) => ({ id, parentId: storyModel.id, rank })),
      document,
      signal,
      onProgress,
    );
    return { story: storyModel, comments };
  }

  async loadCommentSubtrees(
    story: StoryId,
    roots: readonly HnCommentRoot[],
    document: Document,
    signal?: AbortSignal,
    onProgress?: (loaded: number, totalKnown: number) => void,
  ): Promise<readonly Comment[]> {
    const queue: HnCommentRoot[] = [...roots];
    const comments: Comment[] = [];
    const visited = new Set<CommentId>();
    while (queue.length > 0) {
      if (signal?.aborted) throw signal.reason;
      const batch = queue.splice(0, 16);
      const items = await Promise.all(batch.map(async (entry) => ({ entry, item: await this.getItem(entry.id, signal, true) })));
      for (const { entry, item } of items) {
        if (visited.has(entry.id) || item.type !== "comment") continue;
        visited.add(entry.id);
        const model = this.toComment(item, story, entry.parentId, entry.rank, document);
        comments.push(model);
        for (const [rank, id] of model.childIds.entries()) queue.push({ id, parentId: model.id, rank });
      }
      onProgress?.(comments.length, comments.length + queue.length);
      if (comments.length + queue.length > 10_000) throw new Error("HN thread exceeded the 10,000 item safety limit");
    }
    return Object.freeze(comments);
  }
}
