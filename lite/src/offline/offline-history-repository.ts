import { DEFAULT_CACHE_TTL_MS, type CacheRepository } from "../cache/cache-repository";
import { hashText } from "../kernel/hash";
import type { StoryId } from "../thread/model";

export interface OfflineDownloadHistoryEntry {
  readonly id: string;
  readonly storyId: StoryId;
  readonly storyTitle: string;
  readonly filename: string;
  readonly savedAt: number;
  readonly bytes: number;
  readonly commentCount: number;
  readonly translatedCount: number;
}

export type OfflineDownloadStage = "translating" | "generating" | "saving";
export type OfflineDownloadStatus = "running" | "ready" | "error";

export interface OfflineDownloadProgress {
  readonly storyTitle: string;
  readonly stage: OfflineDownloadStage;
  readonly status: OfflineDownloadStatus;
  readonly complete: number;
  readonly total: number;
  readonly message: string;
}

interface OfflineDownloadHistory {
  readonly kind: "offline-history";
  readonly entries: readonly OfflineDownloadHistoryEntry[];
}

interface OfflineHtmlArtifact {
  readonly kind: "offline-html";
  readonly id: string;
  readonly html: string;
}

export type CachedOfflineDownload = OfflineDownloadHistory | OfflineHtmlArtifact;

export interface SaveOfflineDownloadInput {
  readonly storyId: StoryId;
  readonly storyTitle: string;
  readonly filename: string;
  readonly html: string;
  readonly commentCount: number;
  readonly translatedCount: number;
}

const HISTORY_KEY = "offline-history:all";
const ARTIFACT_KEY_PREFIX = "offline-html:";
const MAX_OFFLINE_HISTORY = 20;

export class OfflineHistoryRepository {
  constructor(
    readonly cache: CacheRepository<CachedOfflineDownload>,
    readonly now: () => number = Date.now,
  ) {}

  async list(): Promise<readonly OfflineDownloadHistoryEntry[]> {
    const cached = await this.cache.get(HISTORY_KEY);
    if (cached?.kind !== "offline-history") return Object.freeze([]);
    const oldest = this.now() - DEFAULT_CACHE_TTL_MS;
    return Object.freeze(cached.entries
      .filter((entry) => entry.savedAt > oldest)
      .sort((left, right) => right.savedAt - left.savedAt)
      .slice(0, MAX_OFFLINE_HISTORY));
  }

  async save(input: SaveOfflineDownloadInput): Promise<OfflineDownloadHistoryEntry> {
    const id = `${input.storyId}:${hashText(input.html)}`;
    const entry: OfflineDownloadHistoryEntry = Object.freeze({
      id,
      storyId: input.storyId,
      storyTitle: input.storyTitle,
      filename: input.filename,
      savedAt: this.now(),
      bytes: new TextEncoder().encode(input.html).byteLength,
      commentCount: input.commentCount,
      translatedCount: input.translatedCount,
    });
    await this.cache.set(`${ARTIFACT_KEY_PREFIX}${id}`, Object.freeze({ kind: "offline-html", id, html: input.html }));
    const previous = await this.list();
    const candidates = [entry, ...previous.filter((item) => item.id !== id)];
    const entries = Object.freeze(candidates.slice(0, MAX_OFFLINE_HISTORY));
    await this.cache.set(HISTORY_KEY, Object.freeze({ kind: "offline-history", entries }));
    await Promise.allSettled(candidates
      .slice(MAX_OFFLINE_HISTORY)
      .map((item) => this.cache.delete(`${ARTIFACT_KEY_PREFIX}${item.id}`)));
    return entry;
  }

  async getHtml(id: string): Promise<string | undefined> {
    const cached = await this.cache.get(`${ARTIFACT_KEY_PREFIX}${id}`);
    return cached?.kind === "offline-html" && cached.id === id ? cached.html : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const previous = await this.list();
    if (!previous.some((entry) => entry.id === id)) return false;
    const entries = Object.freeze(previous.filter((entry) => entry.id !== id));
    await Promise.all([
      this.cache.set(HISTORY_KEY, Object.freeze({ kind: "offline-history", entries })),
      this.cache.delete(`${ARTIFACT_KEY_PREFIX}${id}`),
    ]);
    return true;
  }

  clear(): Promise<void> {
    return this.cache.clear();
  }
}
