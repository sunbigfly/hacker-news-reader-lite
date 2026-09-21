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
 */
export function applyVocabularyInk(mark: HTMLElement, index: number): void {
  const color = VOCABULARY_INK_COLORS[index % VOCABULARY_INK_COLORS.length] ?? VOCABULARY_INK_COLORS[0] ?? "#e995ab";
  mark.style.setProperty("--hnr-vocabulary-ink", color);
  mark.style.removeProperty("text-decoration");
  mark.style.setProperty("box-decoration-break", "clone");
  mark.style.setProperty("-webkit-box-decoration-break", "clone");
  const document = mark.ownerDocument;
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
  mark.append(brush);
}

/** One root is the common case; the array form covers the several copies bilingual mode renders. */
function inkRootList(value: readonly Element[] | Element): readonly Element[] {
  return value instanceof Element ? [value] : value;
}

function textNodes(root: Element): Text[] {
  const document = root.ownerDocument;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text) || !node.data.trim()) continue;
    if (node.parentElement?.closest(SKIP_SELECTOR)) continue;
    nodes.push(node);
  }
  return nodes;
}

/**
 * Marks selected vocabulary inside comment bodies and always restores the exact original text,
 * so turning the feature off leaves the comment DOM byte-identical to the first render.
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
   * Inks one word list into every root that currently shows the comment text. Bilingual mode renders
   * one original section per paragraph, so a caller that passes only the first root would leave the
   * rest of a multi-paragraph comment unhighlighted.
   */
  apply(roots: readonly Element[] | Element, words: readonly VocabularyWord[]): readonly HTMLElement[] {
    this.clear();
    for (const word of words) this.#words.add(word.word);
    const created: HTMLElement[] = [];
    for (const root of inkRootList(roots)) {
      const marks: HTMLElement[] = [];
      // The colour follows the word, not the root, so a word keeps one colour in every paragraph.
      for (const [index, word] of words.entries()) marks.push(...this.#mark(root, word, index));
      if (marks.length === 0) continue;
      this.#roots.set(root, Object.freeze(marks));
      created.push(...marks);
    }
    return Object.freeze(created);
  }

  clear(): void {
    for (const marks of this.#roots.values()) {
      for (const mark of marks) {
        if (!mark.isConnected) continue;
        // Mirrors the reference: restore the word, then drop the mark element itself.
        mark.replaceWith(mark.ownerDocument.createTextNode(mark.textContent ?? ""));
      }
    }
    this.#roots.clear();
    this.#words.clear();
  }

  #mark(root: Element, word: VocabularyWord, index: number): readonly HTMLElement[] {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapePattern(word.word)}(?![\\p{L}\\p{N}_])`, "giu");
    const marks: HTMLElement[] = [];
    for (const text of textNodes(root)) {
      const matches = [...text.data.matchAll(pattern)];
      if (matches.length === 0) continue;
      const fragment = text.ownerDocument.createDocumentFragment();
      let offset = 0;
      for (const match of matches) {
        const start = match.index;
        const end = start + match[0].length;
        fragment.append(text.data.slice(offset, start));
        const mark = text.ownerDocument.createElement("mark");
        mark.dataset.vocabularyInk = "";
        mark.dataset.vocabularyWord = word.word;
        mark.textContent = match[0];
        mark.setAttribute("aria-label", `${word.word} ${word.ipa} ${word.meaning}`);
        applyVocabularyInk(mark, index);
        fragment.append(mark);
        marks.push(mark);
        offset = end;
      }
      fragment.append(text.data.slice(offset));
      text.replaceWith(fragment);
    }
    for (const mark of marks) this.onMark?.(mark, word, root);
    return marks;
  }
}
