export type StoryId = number & { readonly __storyId: unique symbol };
export type CommentId = number & { readonly __commentId: unique symbol };
export type ItemId = StoryId | CommentId;

function positiveSafeInteger(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new TypeError(`${label} must be a positive safe integer`);
  return parsed;
}

export function storyId(value: unknown): StoryId {
  return positiveSafeInteger(value, "story id") as StoryId;
}

export function commentId(value: unknown): CommentId {
  return positiveSafeInteger(value, "comment id") as CommentId;
}

export type ContentSource = "cache" | "api" | "dom";

export interface Story {
  readonly id: StoryId;
  readonly title: string;
  readonly url: string | null;
  readonly author: string | null;
  readonly score: number | null;
  readonly html: string;
  readonly childIds: readonly CommentId[];
  readonly descendants: number | null;
  readonly observedAt: number;
}

export interface Comment {
  readonly id: CommentId;
  readonly storyId: StoryId;
  readonly parentId: ItemId;
  readonly childIds: readonly CommentId[];
  readonly rank: number;
  readonly author: string | null;
  readonly createdAt: number | null;
  readonly html: string;
  readonly text: string;
  readonly deleted: boolean;
  readonly dead: boolean;
  readonly source: ContentSource;
  readonly observedAt: number;
}

export interface ThreadSnapshot {
  readonly schemaVersion: 1;
  readonly story: Story;
  readonly comments: readonly Comment[];
  readonly loadedIds: readonly CommentId[];
  readonly missingIds: readonly CommentId[];
  readonly complete: boolean;
  readonly capturedAt: number;
}
