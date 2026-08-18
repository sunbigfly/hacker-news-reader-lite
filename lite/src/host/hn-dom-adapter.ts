import { sanitizeHtml } from "../security/sanitize-html";
import {
  commentId,
  storyId,
  type Comment,
  type CommentId,
  type Story,
  type StoryId,
  type ThreadSnapshot,
} from "../thread/model";

function parseInteger(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const match = /\d+/.exec(raw);
  return match ? Number.parseInt(match[0], 10) : null;
}

function parseCreatedAt(row: Element): number | null {
  const title = row.querySelector<HTMLElement>(".age")?.title;
  if (!title) return null;
  const parsed = Date.parse(title);
  return Number.isFinite(parsed) ? parsed : null;
}

function storySubtext(row: Element): Element | null {
  return row.nextElementSibling?.querySelector(".subtext") ?? null;
}

function storyFromRow(
  document: Document,
  storyRow: HTMLTableRowElement,
  id: StoryId,
  childIds: readonly CommentId[],
  observedAt: number,
  descendants: number | null,
): Story {
  const titleLink = storyRow.querySelector<HTMLAnchorElement>(".titleline > a");
  const title = titleLink?.textContent?.trim();
  if (!title) throw new Error("HN story title was not found");
  const subtext = storySubtext(storyRow);
  const storyHtmlElement = document.querySelector<HTMLElement>(".toptext");
  const storyHtml = sanitizeHtml(storyHtmlElement?.innerHTML ?? "", document, document.baseURI);
  return {
    id,
    title,
    url: titleLink?.href && !titleLink.href.startsWith("https://news.ycombinator.com/item") ? titleLink.href : null,
    author: subtext?.querySelector<HTMLElement>(".hnuser")?.textContent?.trim() || null,
    score: parseInteger(subtext?.querySelector(".score")?.textContent),
    html: storyHtml,
    childIds,
    descendants,
    observedAt,
  };
}

export function parseHnStoryPreview(
  document: Document,
  expectedStoryId: StoryId,
  observedAt = Date.now(),
): ThreadSnapshot | null {
  const storyRow = document.querySelector<HTMLTableRowElement>(
    `tr.athing:not(.comtr)[id="${expectedStoryId}"]`,
  );
  if (!storyRow) return null;
  const subtext = storySubtext(storyRow);
  const descendants = parseInteger(subtext?.querySelector(".comments")?.textContent);
  return {
    schemaVersion: 1,
    story: storyFromRow(document, storyRow, expectedStoryId, Object.freeze([]), observedAt, descendants),
    comments: Object.freeze([]),
    loadedIds: Object.freeze([]),
    missingIds: Object.freeze([]),
    complete: false,
    capturedAt: observedAt,
  };
}

export function parseHnDocument(
  document: Document,
  observedAt = Date.now(),
  commentLimit = Number.POSITIVE_INFINITY,
): ThreadSnapshot {
  if (!(commentLimit === Number.POSITIVE_INFINITY || (Number.isSafeInteger(commentLimit) && commentLimit > 0))) {
    throw new RangeError("comment limit must be a positive integer");
  }
  const storyRow = document.querySelector<HTMLTableRowElement>("tr.athing:not(.comtr)");
  if (!storyRow?.id) throw new Error("HN story row was not found");
  const id = storyId(storyRow.id);

  const mutableComments: Comment[] = [];
  const stack: CommentId[] = [];
  const rankByParent = new Map<number, number>();
  const commentRows = document.querySelectorAll<HTMLTableRowElement>("tr.athing.comtr");
  let visitedRows = 0;
  for (const row of commentRows) {
    if (mutableComments.length >= commentLimit) break;
    visitedRows += 1;
    if (!row.id) continue;
    let idValue: CommentId;
    try {
      idValue = commentId(row.id);
    } catch {
      continue;
    }
    const indentWidth = parseInteger(row.querySelector<HTMLImageElement>("td.ind img")?.getAttribute("width")) ?? 0;
    const depth = Math.max(0, Math.round(indentWidth / 40));
    const parentId = depth > 0 ? stack[depth - 1] ?? id : id;
    stack.length = depth;
    stack[depth] = idValue;
    const rank = rankByParent.get(parentId) ?? 0;
    rankByParent.set(parentId, rank + 1);
    const commentElement = row.querySelector<HTMLElement>(".commtext");
    const html = commentElement?.innerHTML ?? "";
    const text = (commentElement?.textContent ?? "").replace(/\s+/g, " ").trim();
    const author = row.querySelector<HTMLElement>(".hnuser")?.textContent?.trim() || null;
    mutableComments.push({
      id: idValue,
      storyId: id,
      parentId,
      childIds: [],
      rank,
      author,
      createdAt: parseCreatedAt(row),
      html,
      text,
      deleted: author === null && /^\[deleted\]$/i.test(text),
      dead: row.classList.contains("dead") || commentElement?.classList.contains("cdd") === true,
      source: "dom",
      observedAt,
    });
  }

  const children = new Map<number, CommentId[]>();
  for (const comment of mutableComments) {
    const list = children.get(comment.parentId) ?? [];
    list.push(comment.id);
    children.set(comment.parentId, list);
  }
  const comments = mutableComments.map((comment) => ({
    ...comment,
    childIds: Object.freeze(children.get(comment.id) ?? []),
  }));
  const roots = Object.freeze(children.get(id) ?? []);
  const story = storyFromRow(document, storyRow, id, roots, observedAt, commentRows.length);
  return {
    schemaVersion: 1,
    story,
    comments: Object.freeze(comments),
    loadedIds: Object.freeze(comments.map((comment) => comment.id)),
    missingIds: Object.freeze([] as CommentId[]),
    complete: visitedRows === commentRows.length && document.querySelector("a.morelink") === null,
    capturedAt: observedAt,
  };
}

export function findStoryIdFromRow(row: Element): StoryId | null {
  const storyRow = row.matches("tr.athing") ? row : row.closest("tr.athing");
  if (!storyRow?.id) return null;
  try {
    return storyId(storyRow.id);
  } catch {
    return null;
  }
}
