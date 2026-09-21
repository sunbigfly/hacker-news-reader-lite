import type { VocabularyWord } from "./model";
import { addWord } from "./wordbook";
import { bookmarkButton, soundButton } from "./word-popup";

export interface VocabularySectionOptions {
  readonly sourceUrl: string;
  readonly onSaved: () => void;
  readonly onExpandChange?: ((expanded: boolean) => void) | undefined;
  /** Absent on touch or narrow viewports, where hovering is not available. */
  readonly openWordPopup?: ((anchor: HTMLElement, word: VocabularyWord) => () => void) | undefined;
}

const COLLAPSED_WORDS = 3;
const MEANING_LANGUAGES = "zh-Hans";

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className: string,
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

/**
 * Sits directly under one comment body and stays as quiet as possible: a single hairline separates
 * it from the comment, and the word rows are the only content. It owns just its own DOM — the
 * controller decides when to create it, what to put in it and when to drop it.
 */
export class VocabularySection {
  readonly #options: VocabularySectionOptions;
  readonly #status: HTMLParagraphElement;
  readonly #list: HTMLDivElement;
  readonly #more: HTMLButtonElement;
  #expanded = false;
  #words: readonly VocabularyWord[] = Object.freeze([]);

  constructor(readonly root: HTMLElement, options: VocabularySectionOptions) {
    this.#options = options;
    const document = root.ownerDocument;
    this.root.classList.add("hnr-vocabulary");
    const body = element(document, "fieldset", "hnr-vocabulary-body");
    this.#list = element(document, "div", "hnr-vocabulary-list");
    this.#more = element(document, "button", "hnr-vocabulary-more");
    this.#more.type = "button";
    this.#more.hidden = true;
    this.#more.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.#setExpanded(!this.#expanded);
    });
    this.#status = element(document, "p", "hnr-vocabulary-status");
    this.#status.setAttribute("role", "status");
    body.append(this.#list, this.#more, this.#status);
    this.root.replaceChildren(body);
    this.setWords(Object.freeze([]));
  }

  get words(): readonly VocabularyWord[] {
    return this.#words;
  }

  get expanded(): boolean {
    return this.#expanded;
  }

  /** Recycled rows rebuild the section, so the caller restores the reader's expand choice. */
  setExpanded(expanded: boolean): void {
    this.#setExpanded(expanded);
  }

  setError(message: string): void {
    this.#words = Object.freeze([]);
    this.root.dataset.vocabularyState = "error";
    this.root.hidden = false;
    this.#list.replaceChildren();
    this.#more.hidden = true;
    // Every visible comment would otherwise repeat the same long configuration hint.
    const repeatedlyRecoverable = /API Key|模型|Base URL/u.test(message);
    this.#status.textContent = repeatedlyRecoverable ? "词汇整理未配置 AI，请在阅读设置中填写 Base URL、API Key 与模型。" : message;
  }

  /** An empty answer hides the whole section, so untouched comments keep their exact height. */
  setWords(words: readonly VocabularyWord[]): void {
    this.#words = words;
    this.#list.replaceChildren();
    this.#status.textContent = "";
    this.root.dataset.vocabularyState = words.length > 0 ? "ready" : "empty";
    this.root.hidden = words.length === 0;
    if (words.length === 0) {
      this.#more.hidden = true;
      return;
    }
    // The list speaks for itself: no count line, only the control for words it still holds back.
    for (const [index, word] of words.entries()) this.#list.append(this.#row(word, index));
    this.#updateMore();
  }

  destroy(): void {
    this.root.replaceChildren();
    this.root.hidden = true;
    this.#words = Object.freeze([]);
  }

  #row(word: VocabularyWord, index: number): HTMLElement {
    const document = this.root.ownerDocument;
    const row = element(document, "div", "hnr-word-row");
    row.dataset.vocabularyRow = word.word;
    if (index >= COLLAPSED_WORDS) row.hidden = !this.#expanded;
    const label = element(document, "span", "hnr-word-label", word.word);
    label.title = word.example;
    let dismiss: (() => void) | undefined;
    if (this.#options.openWordPopup) {
      const open = this.#options.openWordPopup;
      label.tabIndex = 0;
      const show = (): void => {
        dismiss?.();
        dismiss = open(label, word);
      };
      const hide = (): void => {
        dismiss?.();
        dismiss = undefined;
      };
      label.addEventListener("pointerenter", show);
      label.addEventListener("focus", show);
      label.addEventListener("pointerleave", hide);
      label.addEventListener("blur", hide);
    }
    const save = bookmarkButton(document, word);
    save.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.#save(word, save);
    });
    const ipa = element(document, "span", "hnr-word-ipa", word.ipa);
    const meaning = element(document, "span", "hnr-word-meaning", word.meaning);
    meaning.title = word.meaning;
    meaning.lang = MEANING_LANGUAGES;
    row.append(label, save, ipa, soundButton(document, word), meaning);
    return row;
  }

  #save(word: VocabularyWord, control: HTMLButtonElement): void {
    try {
      addWord(word, this.#options.sourceUrl);
      control.setAttribute("aria-pressed", "true");
      control.setAttribute("aria-label", `${word.word} 已收藏`);
      control.title = `${word.word} 已收藏`;
      this.#options.onSaved();
    } catch (error) {
      this.#status.textContent = error instanceof Error ? error.message : "收藏失败，请重试";
    }
  }

  #setExpanded(expanded: boolean): void {
    this.#expanded = expanded;
    for (const [index, row] of [...this.#list.children].entries()) {
      if (index >= COLLAPSED_WORDS && row instanceof HTMLElement) row.hidden = !expanded;
    }
    this.#updateMore();
    this.#options.onExpandChange?.(expanded);
  }

  #updateMore(): void {
    const hidden = this.#words.length - COLLAPSED_WORDS;
    this.#more.hidden = hidden <= 0;
    if (hidden <= 0) return;
    this.#more.textContent = this.#expanded ? "收起" : `展开其余 ${hidden} 词`;
    this.#more.setAttribute("aria-expanded", String(this.#expanded));
  }
}
