import { hashText } from "../kernel/hash";
import { sanitizeHtml } from "../security/sanitize-html";
import { translationBlockNeedsTranslation, translationTextPlan } from "../translation/translation-text";
import type { CommentId, ItemId, ThreadSnapshot } from "./model";

export interface PreheatedComment {
  readonly id: CommentId;
  readonly parentId: ItemId;
  readonly depth: number;
  readonly childCount: number;
  readonly searchText: string;
  readonly sanitizedHtml: string;
  readonly translationText: string;
  readonly needsTranslation: boolean;
  readonly contentFingerprint: string;
  readonly estimatedHeight: number;
}

export interface IdleBudget {
  timeRemaining(): number;
}

export interface PreheatIdleScheduler {
  schedule(callback: (budget: IdleBudget) => void): number;
  cancel(handle: number): void;
}

class BrowserIdleScheduler implements PreheatIdleScheduler {
  constructor(readonly view: Window) {}

  schedule(callback: (budget: IdleBudget) => void): number {
    if (typeof this.view.requestIdleCallback === "function") {
      return this.view.requestIdleCallback((deadline) => callback(deadline), { timeout: 250 });
    }
    return this.view.setTimeout(() => callback({ timeRemaining: () => 4 }), 0);
  }

  cancel(handle: number): void {
    if (typeof this.view.cancelIdleCallback === "function") this.view.cancelIdleCallback(handle);
    else this.view.clearTimeout(handle);
  }
}

function estimateHeight(text: string, depth: number, childCount: number): number {
  const lines = Math.max(1, Math.ceil(text.length / Math.max(42, 78 - Math.min(depth, 8) * 3)));
  return Math.min(720, 70 + lines * 25 + (childCount > 0 ? 8 : 0));
}

export class ThreadPreheater {
  readonly #values = new Map<CommentId, PreheatedComment>();
  readonly #scheduler: PreheatIdleScheduler;
  #handle: number | null = null;
  #generation = 0;

  constructor(
    readonly document: Document,
    scheduler?: PreheatIdleScheduler,
  ) {
    const view = document.defaultView;
    if (scheduler) this.#scheduler = scheduler;
    else if (view) this.#scheduler = new BrowserIdleScheduler(view);
    else throw new Error("帖子预热需要浏览器窗口");
  }

  get size(): number { return this.#values.size; }

  get(id: CommentId): PreheatedComment | undefined { return this.#values.get(id); }

  values(): ReadonlyMap<CommentId, PreheatedComment> { return new Map(this.#values); }

  start(snapshot: ThreadSnapshot, onProgress?: (complete: number, total: number) => void): void {
    this.cancel();
    const generation = ++this.#generation;
    const comments = snapshot.comments;
    const byId = new Map(comments.map((comment) => [comment.id, comment]));
    for (const id of this.#values.keys()) {
      if (!byId.has(id)) this.#values.delete(id);
    }
    const depths = new Map<CommentId, number>();
    const depthOf = (id: CommentId): number => {
      const known = depths.get(id);
      if (known !== undefined) return known;
      const trail: CommentId[] = [];
      const seen = new Set<CommentId>();
      let current = byId.get(id);
      while (current && current.parentId !== snapshot.story.id && !depths.has(current.id) && !seen.has(current.id)) {
        seen.add(current.id);
        trail.push(current.id);
        current = byId.get(current.parentId as CommentId);
      }
      let depth = current?.parentId === snapshot.story.id ? 0 : (current ? depths.get(current.id) ?? 0 : 0);
      for (let index = trail.length - 1; index >= 0; index -= 1) {
        const trailId = trail[index];
        if (trailId === undefined) continue;
        depth += 1;
        depths.set(trailId, depth);
      }
      if (!depths.has(id)) depths.set(id, current?.parentId === snapshot.story.id ? 0 : depth);
      return depths.get(id) ?? 0;
    };
    let index = 0;
    const run = (budget: IdleBudget): void => {
      if (generation !== this.#generation) return;
      const startedAt = performance.now();
      let processed = 0;
      while (index < comments.length && processed < 32) {
        if (processed >= 4 && (budget.timeRemaining() <= 1 || performance.now() - startedAt >= 8)) break;
        const comment = comments[index++];
        if (!comment) break;
        const fingerprint = hashText(`${comment.id}|${comment.parentId}|${comment.author ?? ""}|${comment.childIds.join(",")}|${comment.html}`);
        const existing = this.#values.get(comment.id);
        if (existing?.contentFingerprint !== fingerprint) {
          const sanitizedHtml = sanitizeHtml(comment.html, this.document, this.document.baseURI);
          const wrapper = this.document.createElement("div");
          wrapper.innerHTML = sanitizedHtml;
          const translationText = translationTextPlan(wrapper).text;
          const searchText = `${comment.author ?? ""} ${comment.text}`.replace(/\s+/g, " ").trim().toLocaleLowerCase();
          const depth = depthOf(comment.id);
          this.#values.set(comment.id, Object.freeze({
            id: comment.id,
            parentId: comment.parentId,
            depth,
            childCount: comment.childIds.length,
            searchText,
            sanitizedHtml,
            translationText,
            needsTranslation: translationBlockNeedsTranslation(translationText),
            contentFingerprint: fingerprint,
            estimatedHeight: estimateHeight(comment.text, depth, comment.childIds.length),
          }));
        }
        processed += 1;
      }
      onProgress?.(index, comments.length);
      if (index < comments.length) this.#handle = this.#scheduler.schedule(run);
      else this.#handle = null;
    };
    onProgress?.(0, comments.length);
    if (comments.length > 0) this.#handle = this.#scheduler.schedule(run);
  }

  cancel(): void {
    this.#generation += 1;
    if (this.#handle !== null) this.#scheduler.cancel(this.#handle);
    this.#handle = null;
  }

  destroy(): void {
    this.cancel();
    this.#values.clear();
  }
}
