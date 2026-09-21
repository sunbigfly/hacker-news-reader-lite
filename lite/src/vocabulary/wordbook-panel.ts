import { applyVocabularyInk } from "./highlights";
import { localWord, wordFormParts, wordTagLabels } from "./ecdict";
import type { WordLookupService } from "./lookup";
import { soundButton, stopWordSpeech, vocabularyButton } from "./word-popup";
import type { SavedWord } from "./wordbook";

export interface WordbookPanelCallbacks {
  readonly onRemove: (word: string) => void;
  readonly onOpenSource: (entry: SavedWord) => void;
  /** Public dictionaries are only queried for a word the reader actually opens. */
  readonly lookup: WordLookupService;
}

const PAGE_SIZES = Object.freeze([10, 20, 50]);
const LEVEL_LABELS: Readonly<Record<SavedWord["level"], string>> = Object.freeze({
  CET6: "六级",
  "CET6+": "六级以上",
});

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function option(document: Document, value: string, label: string): HTMLOptionElement {
  const node = document.createElement("option");
  node.value = value;
  node.textContent = label;
  return node;
}

function labelled(document: Document, labelText: string, control: HTMLElement): HTMLLabelElement {
  const wrapper = element(document, "label", "hnr-wordbook-field");
  wrapper.append(element(document, "span", "", labelText), control);
  return wrapper;
}

function metaRow(document: Document, parts: readonly string[]): HTMLElement {
  const meta = element(document, "div", "hnr-wordbook-meta");
  for (const part of parts) if (part) meta.append(element(document, "span", "", part));
  return meta;
}

function iconButton(document: Document, label: string, paths: readonly string[]): HTMLButtonElement {
  const node = vocabularyButton(document, label);
  node.className = "hnr-wordbook-icon";
  node.textContent = "";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const data of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", data);
    svg.append(path);
  }
  node.append(svg, element(document, "span", "hnr-wordbook-sr-only", label));
  return node;
}

/**
 * The wordbook is a workbench pane first and a collection second: it follows the same kicker,
 * serif heading, numbered-row and muted-meta language as the summary, download and browsing panes.
 */
export class WordbookPanel {
  readonly #document: Document;
  readonly #callbacks: WordbookPanelCallbacks;
  readonly #lookup: WordLookupService;
  #detailController: AbortController | null = null;
  readonly #toolbar: HTMLDivElement;
  readonly #search: HTMLInputElement;
  readonly #sort: HTMLSelectElement;
  readonly #size: HTMLSelectElement;
  readonly #list: HTMLDivElement;
  readonly #pages: HTMLDivElement;
  readonly #detail: HTMLDivElement;
  readonly #listPage: HTMLDivElement;
  #words: readonly SavedWord[] = Object.freeze([]);
  #page = 1;
  #sortMode: "recent" | "az" = "recent";
  #pageSize = PAGE_SIZES[0] ?? 10;
  #query = "";

  constructor(readonly root: HTMLElement, callbacks: WordbookPanelCallbacks) {
    this.#document = root.ownerDocument;
    this.#callbacks = callbacks;
    this.#lookup = callbacks.lookup;
    this.root.classList.add("hnr-wordbook-pane");
    const document = this.#document;

    const heading = element(document, "div", "hnr-wordbook-heading");
    heading.append(
      element(document, "span", "hnr-summary-section-index", "VOCABULARY / LOCAL ONLY"),
      element(document, "h3", "", "单词本"),
      element(document, "p", "", "阅读时从评论里收藏的单词，按收藏时间或字母顺序排列；数据只保存在本地。"),
    );

    this.#toolbar = element(document, "div", "hnr-wordbook-toolbar");
    this.#search = document.createElement("input");
    this.#search.type = "search";
    this.#search.className = "hnr-wordbook-search";
    this.#search.placeholder = "搜索单词或释义";
    this.#search.setAttribute("aria-label", "搜索单词本");
    this.#sort = document.createElement("select");
    this.#sort.setAttribute("aria-label", "排序");
    this.#sort.append(option(document, "recent", "最近收藏"), option(document, "az", "单词 A–Z"));
    this.#size = document.createElement("select");
    this.#size.setAttribute("aria-label", "每页条数");
    for (const size of PAGE_SIZES) this.#size.append(option(document, String(size), `${size} 词 / 页`));
    this.#toolbar.append(
      this.#search,
      labelled(document, "排序", this.#sort),
      labelled(document, "每页", this.#size),
    );

    this.#list = element(document, "div", "hnr-wordbook-list");
    this.#pages = element(document, "div", "hnr-wordbook-pages");
    // One container per level: the detail replaces the list page instead of stacking under it, so a
    // single `hidden` decides what the pane shows and nothing can leak through.
    this.#listPage = element(document, "div", "hnr-wordbook-page-list");
    this.#listPage.append(heading, this.#toolbar, this.#list, this.#pages);
    this.#detail = element(document, "div", "hnr-wordbook-detail");
    this.#detail.hidden = true;
    this.root.replaceChildren(this.#listPage, this.#detail);

    this.#search.addEventListener("input", () => {
      this.#query = this.#search.value.trim().toLowerCase();
      this.#page = 1;
      this.#renderList();
    });
    this.#sort.addEventListener("change", () => {
      this.#sortMode = this.#sort.value === "az" ? "az" : "recent";
      this.#page = 1;
      this.#renderList();
    });
    this.#size.addEventListener("change", () => {
      const size = Number.parseInt(this.#size.value, 10);
      this.#pageSize = PAGE_SIZES.includes(size) ? size : PAGE_SIZES[0] ?? 10;
      this.#page = 1;
      this.#renderList();
    });
    this.#renderList();
  }

  setWords(words: readonly SavedWord[]): void {
    this.#words = words;
    this.#renderList();
  }

  destroy(): void {
    stopWordSpeech();
    this.#words = Object.freeze([]);
    this.root.replaceChildren();
  }

  #matches(): readonly SavedWord[] {
    const filtered = this.#query
      ? this.#words.filter((entry) => `${entry.word} ${entry.meaning}`.toLowerCase().includes(this.#query))
      : this.#words;
    return Object.freeze([...filtered].sort((left, right) => this.#sortMode === "az"
      ? left.word.localeCompare(right.word)
      : right.addedAt - left.addedAt || left.word.localeCompare(right.word)));
  }

  #renderList(): void {
    const document = this.#document;
    this.#detail.hidden = true;
    this.#detail.replaceChildren();
    // Returning from the second level restores the whole list page in one step.
    this.#listPage.hidden = false;
    const matches = this.#matches();
    const pageCount = Math.max(1, Math.ceil(matches.length / this.#pageSize));
    this.#page = Math.min(this.#page, pageCount);
    const offset = (this.#page - 1) * this.#pageSize;
    this.#list.replaceChildren();
    if (matches.length === 0) {
      this.#list.append(element(document, "p", "hnr-wordbook-empty", this.#words.length > 0
        ? "没有匹配的单词，换个关键词或清空搜索。"
        : "还没有收藏。阅读评论时在词汇区点 ☆ 收藏，单词就会出现在这里。"));
    } else {
      for (const [index, entry] of matches.slice(offset, offset + this.#pageSize).entries()) {
        this.#list.append(this.#row(entry, offset + index));
      }
    }
    this.#renderPages(matches.length, pageCount);
  }

  #row(entry: SavedWord, index: number): HTMLElement {
    const document = this.#document;
    const row = element(document, "article", "hnr-wordbook-row");
    row.dataset.wordbookRow = entry.word;
    row.append(element(document, "span", "hnr-summary-history-number", String(index + 1).padStart(2, "0")));
    const open = vocabularyButton(document, `查看 ${entry.word}`);
    open.className = "hnr-wordbook-open";
    open.dataset.wordbookWord = entry.word;
    open.append(element(document, "strong", "hnr-wordbook-word", entry.word));
    open.addEventListener("click", () => this.#renderDetail(entry));
    const remove = iconButton(document, `移除 ${entry.word}`, [
      "M4 7h16", "M10 11v6", "M14 11v6", "M6 7l1 13h10l1-13", "M9 7V4h6v3",
    ]);
    remove.classList.add("hnr-wordbook-remove");
    remove.addEventListener("click", () => this.#callbacks.onRemove(entry.word));
    row.append(open, metaRow(document, [entry.ipa, entry.meaning, LEVEL_LABELS[entry.level]]), soundButton(document, entry), remove);
    return row;
  }

  #renderPages(total: number, pageCount: number): void {
    const document = this.#document;
    const previous = vocabularyButton(document, "上一页");
    previous.className = "hnr-wordbook-page";
    previous.textContent = "上一页";
    previous.disabled = this.#page === 1;
    previous.addEventListener("click", () => {
      stopWordSpeech();
      this.#page -= 1;
      this.#renderList();
    });
    const next = vocabularyButton(document, "下一页");
    next.className = "hnr-wordbook-page";
    next.textContent = "下一页";
    next.disabled = this.#page === pageCount;
    next.addEventListener("click", () => {
      stopWordSpeech();
      this.#page += 1;
      this.#renderList();
    });
    const summary = element(document, "span", "hnr-wordbook-summary", `共 ${total} 词 · 第 ${this.#page} / ${pageCount} 页`);
    summary.setAttribute("aria-live", "polite");
    this.#pages.replaceChildren(summary, previous, next);
  }

  /**
   * The second level of the pane: the list is hidden outright rather than pushed down, so opening a
   * word reads as a page change and never leaves the pagination floating above the detail.
   */
  #renderDetail(entry: SavedWord): void {
    const document = this.#document;
    // Hiding the whole list page is what makes this read as a second level instead of a stack.
    this.#listPage.hidden = true;
    this.#detail.hidden = false;

    const back = vocabularyButton(document, "返回单词本");
    back.className = "hnr-wordbook-back";
    back.textContent = "← 返回单词本";
    back.addEventListener("click", () => this.#renderList());
    const route = element(document, "span", "hnr-summary-section-index", "VOCABULARY / WORD");
    const nav = element(document, "div", "hnr-wordbook-nav");
    nav.append(back, route);

    const hero = element(document, "section", "hnr-wordbook-hero");
    const line = element(document, "div", "hnr-wordbook-hero-line");
    line.append(
      element(document, "strong", "hnr-wordbook-hero-word", entry.word),
      soundButton(document, entry),
      element(document, "span", "hnr-wordbook-hero-ipa", entry.ipa),
      element(document, "span", "hnr-wordbook-level", LEVEL_LABELS[entry.level]),
    );
    const meaning = element(document, "p", "hnr-wordbook-hero-meaning", entry.meaning);
    meaning.lang = "zh-Hans";
    hero.append(line, meaning);

    const example = element(document, "section", "hnr-wordbook-section");
    const sentence = element(document, "p", "hnr-wordbook-example");
    appendInkedWord(document, sentence, entry.example, entry.word);
    const translation = element(document, "p", "hnr-wordbook-example-meaning", entry.exampleMeaning);
    translation.lang = "zh-Hans";
    example.append(
      element(document, "span", "hnr-summary-section-index", "EXAMPLE / MEMORY"),
      element(document, "h3", "", "记忆例句"),
      sentence,
      translation,
    );

    const study = element(document, "aside", "hnr-wordbook-study");
    study.append(element(document, "h3", "", "收藏信息"));
    const facts = element(document, "dl");
    facts.append(
      element(document, "dt", "", "难度"),
      element(document, "dd", "", LEVEL_LABELS[entry.level]),
      element(document, "dt", "", "收藏日期"),
      element(document, "dd", "", timeText(entry.addedAt)),
      element(document, "dt", "", "读音"),
      element(document, "dd", "", entry.ipa),
    );
    study.append(facts);
    const actions = element(document, "div", "hnr-wordbook-actions");
    const source = vocabularyButton(document, "打开收藏来源");
    source.className = "hnr-wordbook-action";
    source.textContent = "打开收藏来源";
    source.addEventListener("click", () => this.#callbacks.onOpenSource(entry));
    const remove = vocabularyButton(document, "移除收藏");
    remove.className = "hnr-wordbook-action hnr-wordbook-action-danger";
    remove.textContent = "移除收藏";
    remove.addEventListener("click", () => this.#callbacks.onRemove(entry.word));
    actions.append(source, remove);
    study.append(actions);

    // One tab per source, exactly as the reference userscript does: offline dictionary, the two
    // public lookups, and the example the word was collected with.
    const dictionary = element(document, "div", "hnr-wordbook-source");
    const bilingual = element(document, "div", "hnr-wordbook-source");
    // Each provider owns its own slot, so one failing lookup can never blank the other.
    const offline = element(document, "div", "hnr-wordbook-slot", "正在读取离线英汉词库…");
    const online = element(document, "div", "hnr-wordbook-slot", "正在读取在线词典…");
    dictionary.append(offline, online);
    bilingual.append(loadingNote(document, "正在读取双语例句…"));
    const panels: readonly [string, HTMLElement][] = [["双语学习", bilingual], ["记忆例句", example], ["英文详解", dictionary]];
    const tabs = element(document, "div", "hnr-wordbook-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "词汇来源");
    const controls = panels.map(([name, panel], index) => {
      const tab = vocabularyButton(document, name);
      tab.className = "hnr-wordbook-tab";
      tab.textContent = name;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(index === 0));
      panel.hidden = index !== 0;
      const select = (): void => {
        panels.forEach(([, candidate], position) => { candidate.hidden = position !== index; });
        controls.forEach((control, position) => control.setAttribute("aria-selected", String(position === index)));
      };
      tab.addEventListener("click", select);
      tabs.append(tab);
      return tab;
    });

    const columns = element(document, "div", "hnr-wordbook-columns");
    const main = element(document, "div", "hnr-wordbook-main");
    main.append(tabs, ...panels.map(([, panel]) => panel));
    columns.append(main, study);
    this.#detail.replaceChildren(nav, hero, columns);
    back.focus({ preventScroll: true });
    this.#loadWordSources(entry, { bilingual, offline, online });
  }

  /**
   * Fills the two lookup tabs. Each provider is independent: one failing never blanks the other, and
   * the offline dictionary answers first because it needs no network at all.
   */
  #loadWordSources(entry: SavedWord, panels: { readonly bilingual: HTMLElement; readonly offline: HTMLElement; readonly online: HTMLElement }): void {
    const document = this.#document;
    const controller = this.#detailController ?? new AbortController();
    this.#detailController = controller;
    const { signal } = controller;
    const guard = (): boolean => signal.aborted || !panels.offline.isConnected;

    void localWord(entry.word).then((local) => {
      if (guard()) return;
      if (!local) {
        panels.offline.replaceChildren(element(document, "p", "hnr-wordbook-note", "离线核心词库暂未收录此词。"));
        return;
      }
      const block = element(document, "div", "hnr-wordbook-entry");
      block.append(element(document, "p", "hnr-wordbook-gloss", local.meaning));
      const tags = wordTagLabels(local.tags);
      if (tags.length > 0) {
        const row = element(document, "div", "hnr-wordbook-tags");
        for (const tag of tags) row.append(element(document, "span", "hnr-wordbook-tag", tag));
        block.append(row);
      }
      const forms = wordFormParts(local.exchange);
      if (forms.length > 0) block.append(element(document, "p", "hnr-wordbook-forms", forms.join(" · ")));
      if (local.pos) block.append(element(document, "p", "hnr-wordbook-note", `词性 ${local.pos}`));
      block.append(element(document, "p", "hnr-wordbook-note", "英汉释义 · ECDICT（离线）"));
      panels.offline.replaceChildren(block);
    }).catch(() => {
      if (!guard()) panels.offline.replaceChildren(element(document, "p", "hnr-wordbook-note", "离线词库无法读取，收藏释义仍可查看。"));
    });

    void this.#lookup.loadExamples(entry.word, signal).then((result) => {
      if (signal.aborted || !panels.bilingual.isConnected) return;
      panels.bilingual.replaceChildren();
      if (result.value.length === 0) {
        panels.bilingual.append(element(document, "p", "hnr-wordbook-note", "暂未找到直接对应的中文例句。"));
        return;
      }
      for (const example of result.value) {
        const line = element(document, "p", "hnr-wordbook-example");
        line.lang = "en";
        appendInkedWord(document, line, example.english, entry.word);
        const translated = element(document, "p", "hnr-wordbook-example-meaning", example.chinese);
        translated.lang = "zh-Hans";
        const attribution = element(document, "p", "hnr-wordbook-note", `Tatoeba #${example.id} · ${example.license || "许可见来源"}`);
        panels.bilingual.append(line, translated, attribution);
      }
    }).catch(() => {
      if (signal.aborted || !panels.bilingual.isConnected) return;
      panels.bilingual.replaceChildren(element(document, "p", "hnr-wordbook-note", "双语例句暂时无法获取，其他内容仍可查看。"));
    });

    void this.#lookup.loadDictionary(entry.word, signal).then((result) => {
      if (signal.aborted || !panels.online.isConnected) return;
      const block = element(document, "div", "hnr-wordbook-dictionary");
      for (const sense of result.value) {
        block.append(element(document, "h4", "", sense.partOfSpeech || "释义"));
        const list = element(document, "ol", "hnr-wordbook-definitions");
        for (const definition of sense.definitions) {
          const item = element(document, "li", "", definition.definition);
          if (definition.example) item.append(element(document, "p", "hnr-wordbook-note", definition.example));
          list.append(item);
        }
        block.append(list);
      }
      const link = element(document, "a", "hnr-wordbook-note", "来源 Wiktionary");
      link.href = `https://en.wiktionary.org/wiki/${encodeURIComponent(entry.word)}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      block.append(link);
      panels.online.replaceChildren(block);
    }).catch(() => {
      if (signal.aborted || !panels.online.isConnected) return;
      panels.online.replaceChildren(element(document, "p", "hnr-wordbook-note", "在线词典暂时无法获取，离线释义仍可查看。"));
    });
  }
}

function loadingNote(document: Document, message: string): HTMLElement {
  return element(document, "p", "hnr-wordbook-note", message);
}

/** Marks the target word inside its own example, matching how the reader inks comment text. */
function appendInkedWord(document: Document, target: HTMLElement, sentence: string, word: string): void {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu");
  let offset = 0;
  for (const match of sentence.matchAll(pattern)) {
    target.append(sentence.slice(offset, match.index));
    const mark = element(document, "mark", "hnr-wordbook-ink", match[0]);
    applyVocabularyInk(mark, 0);
    target.append(mark);
    offset = match.index + match[0].length;
  }
  target.append(sentence.slice(offset));
}

function timeText(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString();
}
