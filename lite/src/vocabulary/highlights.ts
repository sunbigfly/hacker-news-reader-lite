import { glossPattern } from "./gloss";
import type { VocabularyWord } from "./model";

export const VOCABULARY_INK_COLORS = Object.freeze([
  "#d95d7f",
  "#c9822f",
  "#a8a02a",
  "#40976a",
  "#3d94ad",
  "#5c7bd6",
  "#9a6bc9",
]);

const SKIP_SELECTOR = "code,pre,script,style,textarea,input,select,mark[data-vocabulary-ink]";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
export const VOCABULARY_BRUSH_CLASS = "hnr-vocabulary-brush";

/** The reference userscript's two overlapping strokes, in its own 100x16 brush space. */
const BRUSH_STROKES = Object.freeze([
  Object.freeze(["M3 10 Q25 5 49 8 T97 6", ".24", "8"] as const),
  Object.freeze(["M5 12 Q40 9 65 11 T95 9", ".14", "3"] as const),
]);

export type VocabularyInkLanguage = "en" | "zh";

/** One place the reader currently shows the comment text, and which language lives there. */
export interface VocabularyInkTarget {
  readonly root: Element;
  readonly language: VocabularyInkLanguage;
}

export function inkTarget(root: Element, language: VocabularyInkLanguage = "en"): VocabularyInkTarget {
  return Object.freeze({ root, language });
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Ported from the reference userscript's `applyVocabularyInk`: one two-stroke brush sized and offset
 * in em, drawn behind the glyphs. The ink colour is also published as a custom property so the
 * stylesheet can tint the band behind the letters.
 *
 * The reference paints that brush as a `data:` background image, which cannot work on
 * news.ycombinator.com: the host answers with `img-src 'self' https://account.ycombinator.com`, so the
 * browser refuses the URL and the console reports a CSP violation for every mark. An inline `<svg>`
 * is DOM rather than a fetched image, so the same two strokes survive the host policy. `text-decoration`
 * is left to the stylesheet, and the SVG carries no text, so restoring a mark still yields the word.
 *
 * A mark that wraps onto a second line is a different problem: it has one box per line, and an
 * absolutely positioned child can only be laid out against one of them, so the rest of the word would
 * have no stroke — very visible in Chinese, where a quoted span wraps almost anywhere. Those marks are
 * flagged for the stylesheet, which paints every fragment with a background instead; the reference's
 * own `box-decoration-break: clone` is what makes a background reach each fragment. A mark that is not
 * in the document yet has no fragments to count, so it keeps the brush and is measured when it lands.
 */
export function applyVocabularyInk(mark: HTMLElement, index: number): void {
  const color = VOCABULARY_INK_COLORS[index % VOCABULARY_INK_COLORS.length] ?? VOCABULARY_INK_COLORS[0] ?? "#e995ab";
  mark.style.setProperty("--hnr-vocabulary-ink", color);
  mark.style.removeProperty("text-decoration");
  mark.style.setProperty("box-decoration-break", "clone");
  mark.style.setProperty("-webkit-box-decoration-break", "clone");
  if (mark.isConnected && mark.getClientRects().length > 1) {
    mark.dataset.vocabularyWrap = "line";
    return;
  }
  delete mark.dataset.vocabularyWrap;
  mark.append(brushElement(mark.ownerDocument, color));
}

/** The reference's two strokes, as real elements: no URL, so no host policy can refuse it. */
function brushElement(document: Document, color: string): SVGSVGElement {
  const brush = document.createElementNS(SVG_NAMESPACE, "svg");
  brush.setAttribute("class", VOCABULARY_BRUSH_CLASS);
  brush.setAttribute("viewBox", "0 0 100 16");
  brush.setAttribute("preserveAspectRatio", "none");
  brush.setAttribute("aria-hidden", "true");
  brush.setAttribute("focusable", "false");
  for (const [path, opacity, width] of BRUSH_STROKES) {
    const stroke = document.createElementNS(SVG_NAMESPACE, "path");
    stroke.setAttribute("d", path);
    stroke.setAttribute("fill", "none");
    stroke.setAttribute("stroke", color);
    stroke.setAttribute("stroke-opacity", opacity);
    stroke.setAttribute("stroke-width", width);
    stroke.setAttribute("stroke-linecap", "round");
    brush.append(stroke);
  }
  return brush;
}

interface TextSegment {
  readonly node: Text;
  /** Offsets of this node's text inside the whole subtree text. */
  readonly start: number;
  readonly end: number;
}

/**
 * The whole visible text of a subtree with each text node's offsets inside it, so a span can be found
 * across node boundaries. Two things split the text a match has to cross: inline markup the comment
 * arrived with, and unwrapping an earlier mark, which leaves the word it restored in its own node —
 * searching node by node would miss 「工程学」 whenever the text reads 「工程」 + 「学评论…」.
 */
function textSegments(root: Element): { readonly text: string; readonly segments: readonly TextSegment[] } {
  const segments: TextSegment[] = [];
  let text = "";
  const visit = (parent: Element): void => {
    for (const child of parent.childNodes) {
      if (child instanceof Text) {
        if (!child.data) continue;
        segments.push({ node: child, start: text.length, end: text.length + child.data.length });
        text += child.data;
        continue;
      }
      if (child instanceof Element && !child.matches(SKIP_SELECTOR)) visit(child);
    }
  };
  visit(root);
  return { text, segments };
}

/** The word itself, as a whole word, in the language it was collected from. */
function wordPattern(word: VocabularyWord): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapePattern(word.word)}(?![\\p{L}\\p{N}_])`, "giu");
}

/**
 * The Chinese span a word covers. The model quotes that span straight from the translation it was shown,
 * which is the only way to ink a rendering whose wording differs from the gloss — "the digital
 * equivalent of Morty" is 「数字版莫蒂」, and neither 对应物 nor 等价物 appears there. A translation the
 * reader has since replaced, or an answer collected before this field existed, falls back to matching
 * the gloss itself.
 */
function chinesePattern(word: VocabularyWord, chinese: string): RegExp | null {
  const quoted = word.translationTerm ?? "";
  if (quoted && chinese.includes(quoted)) return new RegExp(escapePattern(quoted), "gu");
  return glossPattern(word.meaning, chinese);
}

/**
 * Marks selected vocabulary inside comment bodies and always restores the exact original text,
 * so turning the feature off leaves the comment DOM byte-identical to the first render.
 *
 * A word is inked wherever the reader can see it: its English form in the original copy, and the
 * Chinese span its gloss shares with the translation, using the same colour and the same hover card
 * so the two are visibly the same word.
 */
export class VocabularyHighlights {
  readonly #roots = new Map<Element, readonly HTMLElement[]>();
  readonly #words = new Set<string>();

  constructor(readonly onMark?: (mark: HTMLElement, word: VocabularyWord, root: Element) => void) {}

  get markCount(): number {
    let count = 0;
    for (const marks of this.#roots.values()) count += marks.length;
    return count;
  }

  isMarked(word: string): boolean {
    return this.#words.has(word.trim().toLowerCase());
  }

  /**
   * Inks one word list into every target that currently shows the comment text. Bilingual mode renders
   * one original section and one translation section per paragraph, so a caller that passes only the
   * first root would leave the rest of a multi-paragraph comment unhighlighted.
   */
  apply(targets: readonly VocabularyInkTarget[], words: readonly VocabularyWord[]): readonly HTMLElement[] {
    this.clear();
    for (const word of words) this.#words.add(word.word);
    const created: HTMLElement[] = [];
    for (const target of targets) {
      const marks: HTMLElement[] = [];
      // The colour follows the word, not the target, so a word keeps one colour everywhere it appears.
      for (const [index, word] of words.entries()) {
        marks.push(...this.#mark(target, word, index));
      }
      if (marks.length === 0) continue;
      this.#roots.set(target.root, Object.freeze(marks));
      created.push(...marks);
    }
    return Object.freeze(created);
  }

  clear(): void {
    for (const [root, marks] of this.#roots) {
      for (const mark of marks) {
        if (!mark.isConnected) continue;
        // Mirrors the reference: restore the word, then drop the mark element itself.
        mark.replaceWith(mark.ownerDocument.createTextNode(mark.textContent ?? ""));
      }
      // Unwrapping leaves the restored word in its own node, which serialises identically but splits the
      // text a later span has to match across. Merging back keeps the copy as the reader first had it.
      if (root.isConnected) root.normalize();
    }
    this.#roots.clear();
    this.#words.clear();
  }

  #mark(target: VocabularyInkTarget, word: VocabularyWord, index: number): readonly HTMLElement[] {
    const pattern = target.language === "zh" ? chinesePattern(word, target.root.textContent ?? "") : wordPattern(word);
    if (!pattern) return Object.freeze([]);
    const { text, segments } = textSegments(target.root);
    const matches = [...text.matchAll(pattern)];
    if (matches.length === 0) return Object.freeze([]);
    const marks: HTMLElement[] = [];
    // Each text node is rebuilt once, carrying a mark for every part of a match that falls inside it. A
    // match crossing an inline element therefore becomes one mark per element, which paints the same.
    for (const segment of segments) {
      const pieces: ({ readonly keep: string } | { readonly mark: string })[] = [];
      let cursor = 0;
      for (const match of matches) {
        const from = Math.max(match.index, segment.start) - segment.start;
        const to = Math.min(match.index + match[0].length, segment.end) - segment.start;
        if (from >= to) continue;
        if (from > cursor) pieces.push({ keep: segment.node.data.slice(cursor, from) });
        pieces.push({ mark: segment.node.data.slice(from, to) });
        cursor = to;
      }
      if (pieces.length === 0) continue;
      if (cursor < segment.node.data.length) pieces.push({ keep: segment.node.data.slice(cursor) });
      const fragment = segment.node.ownerDocument.createDocumentFragment();
      const created: HTMLElement[] = [];
      for (const piece of pieces) {
        if ("keep" in piece) {
          fragment.append(piece.keep);
          continue;
        }
        const mark = segment.node.ownerDocument.createElement("mark");
        mark.dataset.vocabularyInk = "";
        mark.dataset.vocabularyWord = word.word;
        mark.dataset.vocabularyLang = target.language;
        mark.textContent = piece.mark;
        mark.setAttribute("aria-label", `${word.word} ${word.ipa} ${word.meaning}`);
        fragment.append(mark);
        created.push(mark);
      }
      segment.node.replaceWith(fragment);
      // Inked after insertion, because whether a mark wraps is only knowable once it is laid out.
      for (const mark of created) {
        applyVocabularyInk(mark, index);
        marks.push(mark);
      }
    }
    for (const mark of marks) this.onMark?.(mark, word, target.root);
    return marks;
  }
}
