import type { CommentId, StoryId } from "../thread/model";

export const DEFAULT_READER_RATIO = 0.52;
export const MIN_READER_RATIO = 0.32;
export const MAX_READER_RATIO = 0.75;

export interface ReaderWorkspaceState {
  readonly schemaVersion: 2;
  readonly readerRatio: number;
  readonly lastActiveStoryId: StoryId | null;
}

export const DEFAULT_READER_WORKSPACE_STATE: ReaderWorkspaceState = Object.freeze({
  schemaVersion: 2,
  readerRatio: DEFAULT_READER_RATIO,
  lastActiveStoryId: null,
});

const STORAGE_KEY = "hn-reader:workspace-state:v2";
const LEGACY_STORAGE_KEY = "hn-reader:workspace-state:v1";
const TOPIC_STATE_STORAGE_PREFIX = "hn-reader:topic-state:v1:";

export interface ReaderTopicPosition {
  readonly commentId: CommentId;
  readonly offset: number;
}

export interface ReaderTopicState {
  readonly schemaVersion: 1;
  readonly position: ReaderTopicPosition | null;
  readonly collapsedCommentIds: readonly CommentId[];
  readonly storyTitle: string;
  readonly visitedAt: number;
}

export interface ReaderTopicHistoryEntry {
  readonly storyId: StoryId;
  readonly storyTitle: string;
  readonly visitedAt: number;
  readonly position: ReaderTopicPosition | null;
  readonly collapsedCommentCount: number;
}

interface LegacyReaderWorkspaceState {
  readonly readerRatio?: unknown;
  readonly lastClosedStoryId?: unknown;
}

export function normalizeReaderRatio(value: unknown): number {
  const ratio = Number(value);
  if (!Number.isFinite(ratio)) return DEFAULT_READER_RATIO;
  return Math.min(MAX_READER_RATIO, Math.max(MIN_READER_RATIO, ratio));
}

export function normalizeReaderWorkspaceState(value: unknown): ReaderWorkspaceState {
  const record = value && typeof value === "object"
    ? value as Partial<ReaderWorkspaceState> & LegacyReaderWorkspaceState
    : {};
  const rawStoryId = Number(record.lastActiveStoryId ?? record.lastClosedStoryId);
  const lastActiveStoryId = Number.isSafeInteger(rawStoryId) && rawStoryId > 0
    ? rawStoryId as StoryId
    : null;
  return Object.freeze({
    schemaVersion: 2,
    readerRatio: normalizeReaderRatio(record.readerRatio),
    lastActiveStoryId,
  });
}

function normalizeReaderTopicPosition(value: unknown): ReaderTopicPosition | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<ReaderTopicPosition>;
  const rawCommentId = Number(record.commentId);
  const rawOffset = Number(record.offset);
  if (!Number.isSafeInteger(rawCommentId) || rawCommentId <= 0 || !Number.isFinite(rawOffset)) return null;
  return Object.freeze({
    commentId: rawCommentId as CommentId,
    offset: Math.max(0, rawOffset),
  });
}

export function normalizeReaderTopicState(value: unknown): ReaderTopicState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<ReaderTopicState> & Partial<ReaderTopicPosition>;
  const position = normalizeReaderTopicPosition(record.position ?? record);
  const collapsedCommentIds = Array.isArray(record.collapsedCommentIds)
    ? [...new Set(record.collapsedCommentIds
      .map((id) => Number(id))
      .filter((id): id is number => Number.isSafeInteger(id) && id > 0))] as CommentId[]
    : [];
  const storyTitle = typeof record.storyTitle === "string" ? record.storyTitle.trim().slice(0, 500) : "";
  const rawVisitedAt = Number(record.visitedAt);
  const visitedAt = Number.isFinite(rawVisitedAt) && rawVisitedAt > 0 ? rawVisitedAt : 0;
  if (!position && collapsedCommentIds.length === 0 && !storyTitle && visitedAt === 0) return null;
  return Object.freeze({
    schemaVersion: 1,
    position,
    collapsedCommentIds: Object.freeze(collapsedCommentIds),
    storyTitle,
    visitedAt,
  });
}

export class ReaderWorkspaceStateStore {
  load(): ReaderWorkspaceState {
    if (typeof GM_getValue !== "function") return DEFAULT_READER_WORKSPACE_STATE;
    const saved = GM_getValue<unknown>(STORAGE_KEY, undefined);
    if (saved !== undefined) return normalizeReaderWorkspaceState(saved);
    return normalizeReaderWorkspaceState(
      GM_getValue<unknown>(LEGACY_STORAGE_KEY, DEFAULT_READER_WORKSPACE_STATE),
    );
  }

  saveReaderRatio(readerRatio: number): void {
    this.#save({ ...this.load(), readerRatio: normalizeReaderRatio(readerRatio) });
  }

  saveLastActiveStoryId(lastActiveStoryId: StoryId): void {
    this.#save({ ...this.load(), lastActiveStoryId });
  }

  loadTopicState(storyId: StoryId): ReaderTopicState | null {
    if (typeof GM_getValue !== "function") return null;
    return normalizeReaderTopicState(
      GM_getValue<unknown>(`${TOPIC_STATE_STORAGE_PREFIX}${storyId}`, undefined),
    );
  }

  saveTopicState(storyId: StoryId, state: ReaderTopicState): void {
    if (typeof GM_setValue !== "function") return;
    const normalized = normalizeReaderTopicState(state);
    if (normalized) GM_setValue(`${TOPIC_STATE_STORAGE_PREFIX}${storyId}`, normalized);
  }

  listTopicHistory(): readonly ReaderTopicHistoryEntry[] {
    if (typeof GM_listValues !== "function" || typeof GM_getValue !== "function") return Object.freeze([]);
    const entries: ReaderTopicHistoryEntry[] = [];
    for (const key of GM_listValues()) {
      if (!key.startsWith(TOPIC_STATE_STORAGE_PREFIX)) continue;
      const rawStoryId = Number(key.slice(TOPIC_STATE_STORAGE_PREFIX.length));
      if (!Number.isSafeInteger(rawStoryId) || rawStoryId <= 0) continue;
      try {
        const state = normalizeReaderTopicState(GM_getValue<unknown>(key, undefined));
        if (!state) continue;
        entries.push(Object.freeze({
          storyId: rawStoryId as StoryId,
          storyTitle: state.storyTitle || `HN Topic #${rawStoryId}`,
          visitedAt: state.visitedAt,
          position: state.position,
          collapsedCommentCount: state.collapsedCommentIds.length,
        }));
      } catch {
        // A damaged topic record must not hide the remaining browsing history.
      }
    }
    entries.sort((left, right) => right.visitedAt - left.visitedAt || right.storyId - left.storyId);
    return Object.freeze(entries);
  }

  #save(state: ReaderWorkspaceState): void {
    if (typeof GM_setValue === "function") GM_setValue(STORAGE_KEY, normalizeReaderWorkspaceState(state));
  }
}
