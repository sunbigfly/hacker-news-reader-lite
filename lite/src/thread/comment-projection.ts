import type { CommentId, ItemId } from "./model";
import { CommentTree } from "./comment-tree";

export type VisibleCommentEntry = {
  readonly kind: "comment";
  readonly id: CommentId;
  readonly depth: number;
  readonly collapsed: boolean;
  readonly hasChildren: boolean;
};

export type MissingCommentEntry = {
  readonly kind: "missing";
  readonly id: CommentId;
  readonly parentId: ItemId;
  readonly depth: number;
};

export type VisibleEntry = VisibleCommentEntry | MissingCommentEntry;

export class CommentProjection {
  readonly #collapsed = new Set<CommentId>();

  constructor(readonly tree: CommentTree) {}

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
    for (const ancestor of this.tree.ancestors(id)) this.#collapsed.delete(ancestor);
  }

  entries(): readonly VisibleEntry[] {
    const result: VisibleEntry[] = [];
    const visited = new Set<CommentId>();
    const visit = (id: CommentId, parentId: ItemId, depth: number): void => {
      if (visited.has(id)) return;
      visited.add(id);
      const comment = this.tree.get(id);
      if (!comment) {
        result.push({ kind: "missing", id, parentId, depth });
        return;
      }
      const collapsed = this.#collapsed.has(id);
      result.push({
        kind: "comment",
        id,
        depth,
        collapsed,
        hasChildren: comment.childIds.length > 0,
      });
      if (!collapsed) for (const childId of comment.childIds) visit(childId, id, depth + 1);
    };
    for (const rootId of this.tree.story.childIds) visit(rootId, this.tree.story.id, 0);
    return Object.freeze(result);
  }
}
