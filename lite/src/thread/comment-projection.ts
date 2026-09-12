import type { CommentId, ItemId } from "./model";
import { CommentTree } from "./comment-tree";
import { DEFAULT_SETTINGS, type ReplyDisplaySettings } from "../settings/settings-store";

export interface ReplyWindow {
  readonly id: CommentId;
  readonly count: number;
}

export type VisibleCommentEntry = {
  readonly kind: "comment";
  readonly id: CommentId;
  readonly depth: number;
  readonly collapsed: boolean;
  readonly hasChildren: boolean;
  readonly repliesExpanded?: boolean;
};

export type MissingCommentEntry = {
  readonly kind: "missing";
  readonly id: CommentId;
  readonly parentId: ItemId;
  readonly depth: number;
};

export type MoreRepliesEntry = {
  readonly kind: "replies";
  /** First hidden child: becomes the scroll anchor when this page is opened. */
  readonly id: CommentId;
  readonly parentId: CommentId;
  readonly depth: number;
  readonly remainingCount: number;
  readonly countExact: boolean;
  readonly shownCount: number;
};

export type VisibleEntry = VisibleCommentEntry | MissingCommentEntry | MoreRepliesEntry;

export class CommentProjection {
  readonly #collapsed = new Set<CommentId>();
  readonly #replyWindows = new Map<CommentId, number>();
  #settings: ReplyDisplaySettings;

  constructor(readonly tree: CommentTree, settings: ReplyDisplaySettings = DEFAULT_SETTINGS) {
    this.#settings = settings;
  }

  configure(settings: ReplyDisplaySettings): void {
    this.#settings = settings;
  }

  replyWindows(): readonly ReplyWindow[] {
    return Object.freeze([...this.#replyWindows].map(([id, count]) => Object.freeze({ id, count })));
  }

  restoreReplyWindows(windows: readonly ReplyWindow[]): void {
    this.#replyWindows.clear();
    for (const { id, count } of windows) this.#replyWindows.set(id, count);
  }

  expandReplies(id: CommentId): void {
    const counts = this.#replyCounts();
    const current = this.#replyLimit(id, this.tree.ancestors(id).length, counts.get(id)?.count ?? 0);
    if (current === Infinity) return;
    this.#replyWindows.set(id, current + this.#settings.replyPageSize);
  }

  collapseReplies(id: CommentId): void {
    this.#replyWindows.set(id, 0);
  }

  #replyLimit(id: CommentId, depth: number, count: number): number {
    const explicit = this.#replyWindows.get(id);
    if (explicit !== undefined) return explicit;
    if (this.#settings.commentDisplayMode === "expanded") return Infinity;
    if (this.#settings.commentDisplayMode === "roots") return 0;
    return count > this.#settings.replyCollapseThreshold || depth >= this.#settings.commentExpandDepth - 1
      ? 0 : Infinity;
  }

  #replyCounts(): Map<CommentId, { count: number; exact: boolean }> {
    const result = new Map<CommentId, { count: number; exact: boolean }>();
    const visit = (id: CommentId): { count: number; exact: boolean } => {
      const cached = result.get(id);
      if (cached) return cached;
      const comment = this.tree.get(id);
      const stats = { count: 0, exact: Boolean(comment) };
      result.set(id, stats);
      for (const childId of comment?.childIds ?? []) {
        const child = visit(childId);
        stats.count += 1 + child.count;
        stats.exact &&= child.exact;
      }
      return stats;
    };
    for (const id of this.tree.story.childIds) visit(id);
    return result;
  }

  isCollapsed(id: CommentId): boolean {
    return this.#collapsed.has(id);
  }

  toggle(id: CommentId): boolean {
    if (this.#collapsed.delete(id)) return false;
    this.#collapsed.add(id);
    return true;
  }

  collapsedIds(): readonly CommentId[] {
    return Object.freeze([...this.#collapsed]);
  }

  restoreCollapsed(ids: readonly CommentId[]): void {
    this.#collapsed.clear();
    for (const id of ids) this.#collapsed.add(id);
  }

  reveal(id: CommentId): void {
    const path = [...this.tree.ancestors(id), id];
    const counts = this.#replyCounts();
    for (const [index, ancestor] of path.entries()) {
      this.#collapsed.delete(ancestor);
      const child = path[index + 1];
      if (child === undefined) continue;
      const childIndex = this.tree.get(ancestor)?.childIds.indexOf(child) ?? -1;
      if (childIndex < 0) continue;
      const count = Math.ceil((childIndex + 1) / this.#settings.replyPageSize) * this.#settings.replyPageSize;
      const limit = this.#replyLimit(ancestor, index, counts.get(ancestor)?.count ?? 0);
      const previouslyVisible = limit === Infinity ? this.tree.get(ancestor)?.childIds.length ?? 0 : limit;
      this.#replyWindows.set(ancestor, Math.max(count, previouslyVisible));
    }
  }

  entries(): readonly VisibleEntry[] {
    const result: VisibleEntry[] = [];
    const visited = new Set<CommentId>();
    const counts = this.#replyCounts();
    const visit = (id: CommentId, parentId: ItemId, depth: number): void => {
      if (visited.has(id)) return;
      visited.add(id);
      const comment = this.tree.get(id);
      if (!comment) {
        result.push({ kind: "missing", id, parentId, depth });
        return;
      }
      const collapsed = this.#collapsed.has(id);
      const limit = this.#replyLimit(id, depth, counts.get(id)?.count ?? 0);
      result.push({
        kind: "comment",
        id,
        depth,
        collapsed,
        hasChildren: comment.childIds.length > 0,
        repliesExpanded: !collapsed && limit > 0 && comment.childIds.length > 0,
      });
      if (collapsed) return;
      for (const childId of comment.childIds.slice(0, limit)) visit(childId, id, depth + 1);
      const hidden = comment.childIds.slice(limit);
      const firstHidden = hidden[0];
      if (firstHidden !== undefined) {
        result.push({
          kind: "replies", id: firstHidden, parentId: id, depth: depth + 1,
          remainingCount: hidden.reduce((sum, childId) => sum + 1 + (counts.get(childId)?.count ?? 0), 0),
          countExact: hidden.every((childId) => counts.get(childId)?.exact === true),
          shownCount: limit,
        });
      }
    };
    for (const rootId of this.tree.story.childIds) visit(rootId, this.tree.story.id, 0);
    return Object.freeze(result);
  }
}
