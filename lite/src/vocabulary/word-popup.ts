import type { VocabularyWord } from "./model";
import { addWord, findSavedWord } from "./wordbook";

export interface WordPopupOptions {
  readonly container: HTMLElement;
  readonly anchor: HTMLElement;
  readonly word: VocabularyWord;
  readonly sourceUrl: string;
  readonly onSaved?: (word: VocabularyWord) => void;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const SPEAKER_PATHS = ["M11 5 6 9H3v6h3l5 4V5Z", "M15.5 8.5a5 5 0 0 1 0 7", "M18.5 5.5a9 9 0 0 1 0 13"];
const BOOKMARK_PATH = "M7 3.5h10a1 1 0 0 1 1 1v16l-6-4-6 4v-16a1 1 0 0 1 1-1Z";

let activeSpeech: { readonly button: HTMLElement | undefined; readonly word: string } | undefined;

const DEFAULT_CARD_WIDTH = 300;
const DEFAULT_CARD_HEIGHT = 160;
const CARD_GAP = 6;

export function vocabularyIcon(document: Document, paths: readonly string[], filled = false): SVGSVGElement {
  const element = document.createElementNS(SVG_NAMESPACE, "svg");
  element.setAttribute("viewBox", "0 0 24 24");
  element.setAttribute("aria-hidden", "true");
  element.setAttribute("focusable", "false");
  for (const data of paths) {
    const path = document.createElementNS(SVG_NAMESPACE, "path");
    path.setAttribute("d", data);
    if (filled) path.setAttribute("fill", "currentColor");
    element.append(path);
  }
  return element;
}

export function vocabularyButton(document: Document, label: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.setAttribute("aria-label", label);
  element.title = label;
  return element;
}

function speechSupported(): boolean {
  return typeof speechSynthesis !== "undefined" && typeof SpeechSynthesisUtterance !== "undefined";
}

export function stopWordSpeech(): void {
  const active = activeSpeech;
  activeSpeech = undefined;
  active?.button?.classList.remove("is-speaking");
  active?.button?.setAttribute("aria-pressed", "false");
  if (speechSupported()) speechSynthesis.cancel();
}

/** Reads the word with the platform's own English voice; a second press on the same button stops it. */
export function speakWord(word: string, button?: HTMLButtonElement): void {
  if (button && activeSpeech?.button === button && activeSpeech.word === word) {
    stopWordSpeech();
    return;
  }
  stopWordSpeech();
  if (!speechSupported()) return;
  const active = { button, word };
  const clear = (): void => {
    button?.classList.remove("is-speaking");
    button?.setAttribute("aria-pressed", "false");
  };
  const utterance = new SpeechSynthesisUtterance(word);
  utterance.lang = "en-US";
  utterance.rate = 0.85;
  const voice = speechSynthesis.getVoices().find((item) => item.lang === "en-US")
    ?? speechSynthesis.getVoices().find((item) => item.lang.startsWith("en"));
  if (voice) utterance.voice = voice;
  const finish = (): void => {
    if (activeSpeech !== active) return;
    activeSpeech = undefined;
    clear();
  };
  utterance.addEventListener("end", finish);
  utterance.addEventListener("error", finish);
  activeSpeech = active;
  button?.classList.add("is-speaking");
  button?.setAttribute("aria-pressed", "true");
  try {
    speechSynthesis.speak(utterance);
  } catch {
    finish();
  }
}

export function soundButton(document: Document, word: VocabularyWord): HTMLButtonElement {
  const element = vocabularyButton(document, `朗读 ${word.word}`);
  element.className = "hnr-word-sound";
  element.setAttribute("aria-pressed", "false");
  element.append(vocabularyIcon(document, SPEAKER_PATHS));
  element.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    speakWord(word.word, element);
  });
  return element;
}

export function bookmarkButton(document: Document, word: VocabularyWord): HTMLButtonElement {
  const saved = findSavedWord(word.word) !== undefined;
  const element = vocabularyButton(document, saved ? `${word.word} 已收藏` : `收藏 ${word.word}`);
  element.className = "hnr-word-bookmark";
  element.dataset.vocabularySave = word.word;
  element.setAttribute("aria-pressed", String(saved));
  element.append(vocabularyIcon(document, [BOOKMARK_PATH], true));
  return element;
}

/**
 * The hover card lives inside the Reader shell instead of the page body, so it cannot outlive the
 * shell and never participates in Hacker News' own stacking contexts. Callers get one disposer.
 */
export function showWordPopup(options: WordPopupOptions): () => void {
  const { container, anchor, word, sourceUrl } = options;
  const document = container.ownerDocument;
  const host = document.createElement("div");
  host.className = "hnr-word-popup";
  host.dataset.vocabularyOwned = "popup";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    section{box-sizing:border-box;max-height:calc(100vh - 40px);overflow-y:auto;padding:12px;border:1px solid var(--hnr-line);border-radius:10px;background:var(--hnr-paper-raised);color:var(--hnr-ink);font:13px/1.5 system-ui,sans-serif;box-shadow:0 6px 24px #0002;overflow-wrap:anywhere}
    strong{font-size:16px;font-family:var(--hnr-title-font-family,ui-serif,Georgia,serif)}
    p{margin:6px 0;white-space:pre-wrap}
    .hnr-popup-example{font-family:var(--hnr-content-font-family,ui-serif,Charter,Georgia,serif)}
    .hnr-popup-example-meaning{color:var(--hnr-muted)}
    button{font:inherit;color:inherit;background:none;border:0;padding:4px;cursor:pointer}
    button:hover{background:#8882;border-radius:4px}
    svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linejoin:round;stroke-linecap:round}
    .hnr-word-bookmark svg{fill:none}
    .hnr-word-bookmark[aria-pressed="true"]{color:#1d9bf0}
    .hnr-word-bookmark[aria-pressed="true"] svg{fill:currentColor}
    .hnr-word-sound{display:inline-flex;vertical-align:middle}
    .hnr-word-sound.is-speaking{opacity:.5}
    [role="status"]:empty{display:none}
  `;
  const section = document.createElement("section");
  section.setAttribute("role", "dialog");
  section.setAttribute("aria-label", `${word.word} 词汇详情`);
  const heading = document.createElement("strong");
  heading.textContent = word.word;
  const pronunciation = document.createElement("span");
  pronunciation.textContent = ` ${word.ipa} `;
  const meaning = document.createElement("p");
  meaning.textContent = word.meaning;
  const example = document.createElement("p");
  example.className = "hnr-popup-example";
  example.textContent = word.example;
  const exampleMeaning = document.createElement("p");
  exampleMeaning.className = "hnr-popup-example hnr-popup-example-meaning";
  exampleMeaning.textContent = word.exampleMeaning;
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const save = bookmarkButton(document, word);
  save.addEventListener("click", () => {
    try {
      addWord(word, sourceUrl);
      save.setAttribute("aria-pressed", "true");
      save.setAttribute("aria-label", `${word.word} 已收藏`);
      options.onSaved?.(word);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "收藏失败，请重试";
    }
  });
  section.append(heading, soundButton(document, word), pronunciation, meaning, example, exampleMeaning, save, status);
  shadow.append(style, section);
  container.append(host);

  const onScroll = (): void => close();
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") close();
  };
  // Any press outside the card dismisses it, so reading on does not leave a card behind.
  const onOutsidePointer = (event: Event): void => {
    const path = event.composedPath();
    if (path.includes(host) || path.includes(anchor)) return;
    close();
  };
  const close = (): void => {
    stopWordSpeech();
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onScroll);
    document.removeEventListener("keydown", onKey, true);
    document.removeEventListener("pointerdown", onOutsidePointer, true);
    host.remove();
  };
  document.addEventListener("pointerdown", onOutsidePointer, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onScroll);
  document.addEventListener("keydown", onKey, true);
  positionPopup(anchor, host);
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => positionPopup(anchor, host)) : undefined;
  observer?.observe(host);
  return () => {
    observer?.disconnect();
    close();
  };
}

/** Property values that do not establish a containing block; blanks appear in partial CSS engines. */
function isNone(value: string | undefined | null): boolean {
  return !value || value === "none" || value === "auto" || value === "normal" || value === "static";
}

/**
 * A fixed box is laid out against its containing block, which is not the viewport when an ancestor
 * establishes one. The Reader root sets `contain: layout paint style`; a transformed, filtered or
 * container-type ancestor would do the same. The outermost such ancestor wins, and its padding box
 * is the rectangle the popup's offsets are measured against.
 */
function fixedContainingBlock(element: Element): HTMLElement | null {
  const view = element.ownerDocument.defaultView;
  if (!view) return null;
  let block: HTMLElement | null = null;
  // A marked word sits inside further containing blocks, so the whole chain must be inspected.
  for (let current = element.parentElement; current; current = current.parentElement) {
    if (current === element.ownerDocument.documentElement) break;
    const style = view.getComputedStyle(current);
    const positioned = !isNone(style.position);
    const contained = !isNone(style.transform) || !isNone(style.perspective) || !isNone(style.filter)
      || !isNone(style.backdropFilter) || !isNone(style.contain)
      || !isNone(style.containerType) || !isNone(style.willChange);
    if (positioned || contained) block = current;
    // A fixed ancestor owns its own containing block, which this walk cannot express.
    if (style.position === "fixed") break;
  }
  return block;
}

/**
 * Places the card under its word, flipping it above when the word sits near the bottom, and clamps
 * it inside the containing block so it never renders past the reading column.
 */
function positionPopup(anchor: HTMLElement, host: HTMLElement): void {
  const view = host.ownerDocument.defaultView;
  if (!view) return;
  const block = fixedContainingBlock(host);
  const blockRect = block
    ? block.getBoundingClientRect()
    : { left: 0, top: 0, width: view.innerWidth, height: view.innerHeight };
  const anchorRect = anchor.getBoundingClientRect();
  // A fixed box is offset from its containing block, so both the edges and the bracket are
  // expressed in block-local coordinates before clamping.
  const left = placeAxis({
    edge: anchorRect.left - blockRect.left,
    span: blockRect.width,
    size: host.offsetWidth || DEFAULT_CARD_WIDTH,
    gap: 0,
  });
  const top = placeAxis({
    edge: anchorRect.bottom - blockRect.top,
    span: Math.min(blockRect.height, view.innerHeight),
    size: host.offsetHeight || DEFAULT_CARD_HEIGHT,
    gap: CARD_GAP,
  });
  host.style.left = `${left}px`;
  host.style.top = `${top}px`;
}

interface AxisPlacement {
  readonly edge: number;
  readonly span: number;
  readonly size: number;
  readonly gap: number;
}

/** Keeps a box inside its bracket, flipping to the other side of the edge when it does not fit. */
function placeAxis({ edge, span, size, gap }: AxisPlacement): number {
  const minimum = 8;
  const maximum = Math.max(minimum, span - size - 8);
  const outward = edge + gap;
  const inward = edge - gap - size;
  const within = (value: number): boolean => value >= minimum && value <= maximum;
  if (within(outward)) return Math.round(outward);
  // Prefer flipping past the edge over clamping, so the card never covers the word it describes.
  if (within(inward)) return Math.round(inward);
  return Math.round(Math.max(minimum, Math.min(outward, maximum)));
}
