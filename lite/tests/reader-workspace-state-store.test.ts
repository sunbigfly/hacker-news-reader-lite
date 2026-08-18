import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_READER_WORKSPACE_STATE,
  normalizeReaderTopicState,
  normalizeReaderWorkspaceState,
  ReaderWorkspaceStateStore,
} from "../src/settings/reader-workspace-state-store";

afterEach(() => vi.unstubAllGlobals());

describe("reader workspace state", () => {
  it("normalizes persisted ratios and story ids", () => {
    expect(normalizeReaderWorkspaceState({ readerRatio: 0.6, lastActiveStoryId: 42 })).toEqual({
      schemaVersion: 2,
      readerRatio: 0.6,
      lastActiveStoryId: 42,
    });
    expect(normalizeReaderWorkspaceState({ readerRatio: 1, lastClosedStoryId: -1 })).toEqual({
      ...DEFAULT_READER_WORKSPACE_STATE,
      readerRatio: 0.75,
    });
    expect(normalizeReaderWorkspaceState({ readerRatio: 0.58, lastClosedStoryId: 41 })).toEqual({
      schemaVersion: 2,
      readerRatio: 0.58,
      lastActiveStoryId: 41,
    });
  });

  it("persists ratio and last active story without overwriting either field", () => {
    let stored: unknown;
    vi.stubGlobal("GM_getValue", (_key: string, fallback: unknown) => stored ?? fallback);
    vi.stubGlobal("GM_setValue", (_key: string, value: unknown) => { stored = value; });
    const store = new ReaderWorkspaceStateStore();

    store.saveReaderRatio(0.64);
    store.saveLastActiveStoryId(49326409 as never);

    expect(store.load()).toEqual({
      schemaVersion: 2,
      readerRatio: 0.64,
      lastActiveStoryId: 49326409,
    });
  });

  it("migrates the previous last-closed workspace record", () => {
    vi.stubGlobal("GM_getValue", (key: string, fallback: unknown) => key === "hn-reader:workspace-state:v1"
      ? { schemaVersion: 1, readerRatio: 0.61, lastClosedStoryId: 49326408 }
      : fallback);

    expect(new ReaderWorkspaceStateStore().load()).toEqual({
      schemaVersion: 2,
      readerRatio: 0.61,
      lastActiveStoryId: 49326408,
    });
  });

  it("persists an independent physical comment position for every topic", () => {
    const stored = new Map<string, unknown>();
    vi.stubGlobal("GM_getValue", (key: string, fallback: unknown) => stored.get(key) ?? fallback);
    vi.stubGlobal("GM_setValue", (key: string, value: unknown) => { stored.set(key, value); });
    vi.stubGlobal("GM_listValues", () => [...stored.keys()]);
    const store = new ReaderWorkspaceStateStore();

    store.saveTopicState(100 as never, {
      schemaVersion: 1,
      position: { commentId: 121 as never, offset: 37.5 },
      collapsedCommentIds: [105 as never, 116 as never],
      storyTitle: "First topic",
      visitedAt: 100,
    });
    store.saveTopicState(200 as never, {
      schemaVersion: 1,
      position: { commentId: 204 as never, offset: 8 },
      collapsedCommentIds: [],
      storyTitle: "Second topic",
      visitedAt: 200,
    });

    expect(store.loadTopicState(100 as never)).toEqual({
      schemaVersion: 1,
      position: { commentId: 121, offset: 37.5 },
      collapsedCommentIds: [105, 116],
      storyTitle: "First topic",
      visitedAt: 100,
    });
    expect(store.loadTopicState(200 as never)).toEqual({
      schemaVersion: 1,
      position: { commentId: 204, offset: 8 },
      collapsedCommentIds: [],
      storyTitle: "Second topic",
      visitedAt: 200,
    });
    expect(store.listTopicHistory()).toEqual([
      {
        storyId: 200,
        storyTitle: "Second topic",
        visitedAt: 200,
        position: { commentId: 204, offset: 8 },
        collapsedCommentCount: 0,
      },
      {
        storyId: 100,
        storyTitle: "First topic",
        visitedAt: 100,
        position: { commentId: 121, offset: 37.5 },
        collapsedCommentCount: 2,
      },
    ]);
    expect(normalizeReaderTopicState({ commentId: -1, offset: 20 })).toBeNull();
  });
});
