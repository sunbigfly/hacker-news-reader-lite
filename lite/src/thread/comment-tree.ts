import { Signal } from "../kernel/signal";
import type { Comment, CommentId, ItemId, Story, ThreadSnapshot } from "./model";

const SOURCE_PRIORITY = { cache: 0, api: 1, dom: 2 } as const;

function orderedUnique(ids: Iterable<CommentId>): readonly CommentId[] {
  return Object.freeze([...new Set(ids)]);
}

export class CommentTree {
  readonly changed = new Signal<void>();
  readonly #comments = new Map<CommentId, Comment>();
  #story: Story;

  constructor(story: Story, comments: Iterable<Comment> = []) {
    this.#story = story;
    this.ingest(comments);
  }

  get story(): Story {
    return this.#story;
  }

  get size(): number {
    return this.#comments.size;
  }

  updateStory(story: Story): void {
    if (story.id !== this.#story.id) throw new Error("story identity cannot change");
    if (story.observedAt < this.#story.observedAt) return;
    this.#story = story;
    this.#normalizeChildren();
    this.changed.emit();
  }

  ingest(comments: Iterable<Comment>): void {
    let changed = false;
    for (const incoming of comments) {
      if (incoming.storyId !== this.#story.id) throw new Error(`comment ${incoming.id} belongs to another story`);
      if (incoming.id === incoming.parentId) throw new Error(`comment ${incoming.id} cannot parent itself`);
      const existing = this.#comments.get(incoming.id);
      if (!existing || this.#shouldReplace(existing, incoming)) {
        this.#comments.set(incoming.id, incoming);
        changed = true;
      }
    }
    if (!changed && this.#comments.size > 0) return;
    this.#normalizeChildren();
    this.#assertAcyclic();
    this.changed.emit();
  }

  replace(story: Story, comments: Iterable<Comment>): void {
    if (story.id !== this.#story.id) throw new Error("story identity cannot change");
    const replacement = new CommentTree(story, comments);
    this.#story = replacement.story;
    this.#comments.clear();
    for (const comment of replacement.#comments.values()) this.#comments.set(comment.id, comment);
    this.changed.emit();
  }

  get(id: CommentId): Comment | undefined {
    return this.#comments.get(id);
  }

  has(id: CommentId): boolean {
    return this.#comments.has(id);
  }

  values(): readonly Comment[] {
    return Object.freeze([...this.#comments.values()]);
  }

  missingIds(): readonly CommentId[] {
    const missing = new Set<CommentId>();
    for (const id of this.#story.childIds) if (!this.#comments.has(id)) missing.add(id);
    for (const comment of this.#comments.values()) {
      for (const id of comment.childIds) if (!this.#comments.has(id)) missing.add(id);
    }
    return Object.freeze([...missing]);
  }

  ancestors(id: CommentId): readonly CommentId[] {
    const result: CommentId[] = [];
    let current = this.#comments.get(id);
    while (current && current.parentId !== this.#story.id) {
      const parent = this.#comments.get(current.parentId as CommentId);
      if (!parent) break;
      result.push(parent.id);
      current = parent;
    }
    return Object.freeze(result.reverse());
  }

  snapshot(complete: boolean, capturedAt = Date.now()): ThreadSnapshot {
    const comments = this.#orderedComments();
    const missingIds = this.missingIds();
    return {
      schemaVersion: 1,
      story: this.#story,
      comments,
      loadedIds: Object.freeze(comments.map((comment) => comment.id)),
      missingIds,
      complete: complete && missingIds.length === 0,
      capturedAt,
    };
  }

  #shouldReplace(existing: Comment, incoming: Comment): boolean {
    if (incoming.observedAt !== existing.observedAt) return incoming.observedAt > existing.observedAt;
    return SOURCE_PRIORITY[incoming.source] >= SOURCE_PRIORITY[existing.source];
  }

  #normalizeChildren(): void {
    const inferred = new Map<ItemId, Comment[]>();
    for (const comment of this.#comments.values()) {
      const list = inferred.get(comment.parentId) ?? [];
      list.push(comment);
      inferred.set(comment.parentId, list);
    }
    for (const list of inferred.values()) list.sort((left, right) => left.rank - right.rank || left.id - right.id);

    const roots = orderedUnique([
      ...this.#story.childIds,
      ...(inferred.get(this.#story.id) ?? []).map((comment) => comment.id),
    ]);
    this.#story = { ...this.#story, childIds: roots };

    for (const [id, comment] of this.#comments) {
      const children = orderedUnique([
        ...comment.childIds,
        ...(inferred.get(id) ?? []).map((child) => child.id),
      ]);
      if (children.length !== comment.childIds.length || children.some((child, index) => child !== comment.childIds[index])) {
        this.#comments.set(id, { ...comment, childIds: children });
      }
    }
  }

  #assertAcyclic(): void {
    for (const comment of this.#comments.values()) {
      const visited = new Set<CommentId>([comment.id]);
      let parentId: ItemId = comment.parentId;
      while (parentId !== this.#story.id) {
        const parent = this.#comments.get(parentId as CommentId);
        if (!parent) break;
        if (visited.has(parent.id)) throw new Error(`comment cycle includes ${parent.id}`);
        visited.add(parent.id);
        parentId = parent.parentId;
      }
    }
  }

  #orderedComments(): readonly Comment[] {
    const result: Comment[] = [];
    const visited = new Set<CommentId>();
    const visit = (id: CommentId): void => {
      if (visited.has(id)) return;
      visited.add(id);
      const comment = this.#comments.get(id);
      if (!comment) return;
      result.push(comment);
      for (const childId of comment.childIds) visit(childId);
    };
    for (const id of this.#story.childIds) visit(id);
    for (const comment of this.#comments.values()) visit(comment.id);
    return Object.freeze(result);
  }
}
