// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BilingualExample, DictionarySense, WordLookupService } from "../src/vocabulary/lookup";
import type { SavedWord } from "../src/vocabulary/wordbook";
import { WordbookPanel } from "../src/vocabulary/wordbook-panel";

/** A lookup stand-in: the detail page must not depend on a live dictionary in tests. */
export function fakeLookup(options: {
  readonly senses?: readonly DictionarySense[];
  readonly examples?: readonly BilingualExample[];
  readonly failDictionary?: boolean;
} = {}): WordLookupService {
  const senses = options.senses ?? [{ partOfSpeech: "noun", definitions: [{ definition: "a spelling rule", example: "A wordb spelling rule." }] }];
  const examples = options.examples ?? [{
    id: 42,
    english: "An example with wordb inside.",
    chinese: "一个包含 wordb 的例句。",
    translationId: 43,
    owner: "tester",
    translationOwner: "translator",
    license: "CC BY 2.0 FR",
    translationLicense: "CC BY 2.0 FR",
  }];
  return {
    peek: () => undefined,
    loadDictionary: () => (options.failDictionary
      ? Promise.reject(new Error("词典不可用"))
      : Promise.resolve({ value: senses, cached: false })),
    loadExamples: () => Promise.resolve({ value: examples, cached: false }),
  } as unknown as WordLookupService;
}

function saved(index: number, overrides: Partial<SavedWord> = {}): SavedWord {
  const word = `word${String.fromCharCode(97 + index)}`;
  return Object.freeze({
    word,
    ipa: `/${word}/`,
    meaning: `${word} 的释义`,
    example: `An example with ${word} inside.`,
    exampleMeaning: `一个包含 ${word} 的例句。`,
    level: "CET6",
    sourceUrl: `https://news.ycombinator.com/item?id=${index}`,
    addedAt: 1_000 + index,
    ...overrides,
  });
}

const WORDS = Object.freeze([saved(1), saved(0), saved(2)]);

function mount(options: { readonly failDictionary?: boolean } = {}): {
  readonly root: HTMLElement;
  readonly panel: WordbookPanel;
  readonly onRemove: ReturnType<typeof vi.fn>;
  readonly onOpenSource: ReturnType<typeof vi.fn>;
} {
  document.body.innerHTML = '<section class="hnr-summary-pane"></section>';
  const root = document.querySelector<HTMLElement>(".hnr-summary-pane");
  if (!root) throw new Error("fixture missing root");
  const onRemove = vi.fn();
  const onOpenSource = vi.fn();
  const panel = new WordbookPanel(root, {
    onRemove,
    onOpenSource,
    lookup: fakeLookup(options.failDictionary === true ? { failDictionary: true } : {}),
  });
  panel.setWords(WORDS);
  return { root, panel, onRemove, onOpenSource };
}

function wordOf(row: Element): string | undefined {
  return row.querySelector(".hnr-wordbook-word")?.textContent ?? undefined;
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => vi.stubGlobal("speechSynthesis", undefined));

describe("wordbook panel", () => {
  it("leads with the same kicker, heading and description as its sibling panes", () => {
    const { root } = mount();
    expect(root.querySelector(".hnr-summary-section-index")?.textContent).toBe("VOCABULARY / LOCAL ONLY");
    expect(root.querySelector(".hnr-wordbook-heading h3")?.textContent).toBe("单词本");
    expect(root.querySelector(".hnr-wordbook-heading p")?.textContent).toContain("只保存在本地");
    expect(root.classList.contains("hnr-wordbook-pane")).toBe(true);
  });

  it("numbers rows and lists saved words newest first", () => {
    const { root } = mount();
    const rows = [...root.querySelectorAll<HTMLElement>(".hnr-wordbook-row")];
    expect(rows.map((row) => row.dataset.wordbookRow)).toEqual(["wordc", "wordb", "worda"]);
    expect(rows.map((row) => row.querySelector(".hnr-summary-history-number")?.textContent)).toEqual(["01", "02", "03"]);
    expect(rows[0]?.querySelector(".hnr-wordbook-meta")?.textContent).toContain("六级");
    expect(rows[0]?.querySelector(".hnr-wordbook-card-ipa")?.textContent).toBe("/wordc/");
    expect(rows[0]?.querySelector(".hnr-wordbook-card-meaning")?.textContent).toBe("wordc 的释义");
    expect(rows[0]?.querySelector(".hnr-wordbook-card-example")?.textContent).toContain("wordc");
    expect(rows[0]?.querySelector("time")?.getAttribute("datetime")).not.toBe("");
    expect(rows[0]?.querySelectorAll(".hnr-wordbook-card-actions button")).toHaveLength(2);
  });

  it("sorts alphabetically on demand", () => {
    const { root } = mount();
    const sort = root.querySelector<HTMLSelectElement>('select[aria-label="排序"]');
    if (!sort) throw new Error("missing sort control");
    sort.value = "az";
    sort.dispatchEvent(new Event("change"));
    expect([...root.querySelectorAll<HTMLElement>(".hnr-wordbook-row")].map(wordOf))
      .toEqual(["worda", "wordb", "wordc"]);
  });

  it("filters by word or meaning and shows an empty state", () => {
    const { root } = mount();
    const search = root.querySelector<HTMLInputElement>('input[aria-label="搜索单词本"]');
    if (!search) throw new Error("missing search control");
    search.value = "wordb 的释义";
    search.dispatchEvent(new Event("input"));
    expect(root.querySelectorAll(".hnr-wordbook-row")).toHaveLength(1);
    search.value = "nothing matches";
    search.dispatchEvent(new Event("input"));
    expect(root.querySelector(".hnr-wordbook-empty")?.textContent).toContain("没有匹配的单词");
  });

  it("shows the total and disables both page edges on a single page", () => {
    const { root } = mount();
    const pageButtons = (): HTMLButtonElement[] => [...root.querySelectorAll<HTMLButtonElement>(".hnr-wordbook-page")];
    expect(root.querySelector(".hnr-wordbook-summary")?.textContent).toBe("共 3 词 · 第 1 / 1 页");
    expect(pageButtons().map((button) => button.disabled)).toEqual([true, true]);
  });

  it("replaces the list page with a second-level detail page", () => {
    const { root, onRemove, onOpenSource } = mount();
    root.querySelector<HTMLButtonElement>('[data-wordbook-word="wordb"]')?.click();

    // The whole list page steps aside at once, so nothing can leak through behind the detail.
    const listPage = root.querySelector<HTMLElement>(".hnr-wordbook-page-list");
    expect(listPage?.hidden).toBe(true);
    expect(listPage?.querySelector(".hnr-wordbook-heading")).not.toBeNull();
    expect(listPage?.querySelector(".hnr-wordbook-toolbar")).not.toBeNull();
    expect(listPage?.querySelector(".hnr-wordbook-pages")).not.toBeNull();

    const detail = root.querySelector<HTMLElement>(".hnr-wordbook-detail");
    expect(detail?.hidden).toBe(false);
    expect(detail?.querySelector(".hnr-wordbook-nav .hnr-wordbook-back")?.textContent).toBe("← 返回单词本");
    expect(detail?.querySelector(".hnr-wordbook-nav .hnr-summary-section-index")?.textContent).toBe("VOCABULARY / WORD");
    expect(detail?.querySelector(".hnr-wordbook-hero-word")?.textContent).toBe("wordb");
    expect(detail?.querySelector(".hnr-wordbook-hero-ipa")?.textContent).toBe("/wordb/");
    expect(detail?.querySelector(".hnr-wordbook-hero-meaning")?.textContent).toBe("wordb 的释义");
    expect(detail?.querySelector(".hnr-wordbook-section h3")?.textContent).toBe("记忆例句");
    expect(detail?.querySelector(".hnr-wordbook-example-meaning")?.textContent).toContain("wordb");
    expect(detail?.querySelector(".hnr-wordbook-study dd")?.textContent).toBe("六级");

    detail?.querySelector<HTMLButtonElement>(".hnr-wordbook-action")?.click();
    expect(onOpenSource).toHaveBeenCalledWith(expect.objectContaining({ word: "wordb" }));
    detail?.querySelector<HTMLButtonElement>(".hnr-wordbook-action-danger")?.click();
    expect(onRemove).toHaveBeenCalledWith("wordb");
  });

  it("leads with dictionary information and exposes examples as adjacent tabs", () => {
    const { root } = mount();
    root.querySelector<HTMLButtonElement>('[data-wordbook-word="wordb"]')?.click();
    const tabs = [...root.querySelectorAll<HTMLButtonElement>(".hnr-wordbook-tab")];
    expect(tabs.map((tab) => tab.textContent)).toEqual(["词典释义", "双语例句", "收藏例句"]);
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    const panels = [...root.querySelectorAll<HTMLElement>(".hnr-wordbook-source")];
    expect(panels).toHaveLength(2);
    expect(panels.map((panel) => panel.hidden)).toEqual([false, true]);

    tabs[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(tabs.map((tab) => tab.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    expect(tabs.map((tab) => tab.tabIndex)).toEqual([-1, 0, -1]);
    expect(panels.map((panel) => panel.hidden)).toEqual([true, false]);
  });

  it("switches every panel of the row, including the memory example", () => {
    const { root } = mount();
    root.querySelector<HTMLButtonElement>('[data-wordbook-word="wordb"]')?.click();
    const main = root.querySelector<HTMLElement>(".hnr-wordbook-main");
    // The panel classes carry their own `display`, so the stylesheet must close them by attribute.
    const panels = [...(main?.querySelectorAll<HTMLElement>(":scope > :not(.hnr-wordbook-tabs)") ?? [])];
    expect(panels.map((panel) => panel.className))
      .toEqual(["hnr-wordbook-source", "hnr-wordbook-source", "hnr-wordbook-section"]);
    const shown = (): readonly string[] => panels.filter((panel) => !panel.hidden).map((panel) => panel.className);

    expect(shown()).toEqual(["hnr-wordbook-source"]);
    root.querySelectorAll<HTMLButtonElement>(".hnr-wordbook-tab")[1]?.click();
    expect(shown()).toEqual(["hnr-wordbook-source"]);
    root.querySelectorAll<HTMLButtonElement>(".hnr-wordbook-tab")[2]?.click();
    expect(shown()).toEqual(["hnr-wordbook-section"]);
    expect(panels[2]?.hidden).toBe(false);
    expect(panels[0]?.hidden).toBe(true);
  });

  it("declares a hidden guard for tab panels whose class sets a display", () => {
    const css = readFileSync(resolve("lite/styles/10-reader.css"), "utf8");
    // Without this guard `display: grid` on the panel beats the `hidden` attribute and two tabs show.
    expect(css).toMatch(/\.hnr-wordbook-main > \[hidden\]\s*\{\s*display: none !important;\s*\}/u);
  });

  it("fills the lookup tabs from the dictionary and keeps them independent", async () => {
    const { root } = mount();
    root.querySelector<HTMLButtonElement>('[data-wordbook-word="wordb"]')?.click();
    await flush();
    const panels = [...root.querySelectorAll<HTMLElement>(".hnr-wordbook-source")];
    // English definitions keep Wiktionary's part of speech and examples visible.
    expect(panels[0]?.textContent).toContain("a spelling rule");
    expect(panels[0]?.textContent).toContain("A wordb spelling rule.");
    expect(panels[0]?.querySelector("a")?.getAttribute("href")).toContain("en.wiktionary.org");
    // Bilingual examples keep the sentence, attribution, contributors and licensing from Tatoeba.
    expect(panels[1]?.textContent).toContain("一个包含 wordb 的例句。");
    expect(panels[1]?.querySelector("mark.hnr-wordbook-ink")?.textContent).toBe("wordb");
    expect(panels[1]?.textContent).toContain("Tatoeba #42 / #43");
    expect(panels[1]?.textContent).toContain("英文 tester / 中文 translator");
    expect(panels[1]?.textContent).toContain("CC BY 2.0 FR");
  });

  it("keeps the bilingual tab usable when the dictionary lookup fails", async () => {
    const { root } = mount({ failDictionary: true });
    root.querySelector<HTMLButtonElement>('[data-wordbook-word="wordb"]')?.click();
    await flush();
    const panels = [...root.querySelectorAll<HTMLElement>(".hnr-wordbook-source")];
    expect(panels[1]?.textContent).toContain("一个包含 wordb 的例句。");
    // The failing provider reports itself instead of blanking the other one.
    expect(panels[0]?.textContent).toMatch(/无法获取|暂未收录/);
  });

  it("inks the saved word inside its own example sentence", () => {
    const { root } = mount();
    root.querySelector<HTMLButtonElement>('[data-wordbook-word="wordb"]')?.click();
    const sentence = root.querySelector<HTMLElement>(".hnr-wordbook-example");
    const mark = sentence?.querySelector<HTMLElement>("mark.hnr-wordbook-ink");
    expect(mark?.textContent).toBe("wordb");
    expect(mark?.dataset.vocabularyInk).toBe("");
    expect(mark?.querySelector(":scope > svg.hnr-vocabulary-brush")).not.toBeNull();
    expect(mark?.style.getPropertyValue("--hnr-vocabulary-ink")).toMatch(/^#/);
    expect(sentence?.textContent).toBe("An example with wordb inside.");
  });

  it("returns to the list page with its header restored", () => {
    const { root, panel } = mount();
    root.querySelector<HTMLButtonElement>('[data-wordbook-word="worda"]')?.click();
    root.querySelector<HTMLButtonElement>(".hnr-wordbook-back")?.click();
    expect(root.querySelector<HTMLElement>(".hnr-wordbook-page-list")?.hidden).toBe(false);
    expect(root.querySelector<HTMLElement>(".hnr-wordbook-detail")?.hidden).toBe(true);
    expect(root.querySelector<HTMLElement>(".hnr-wordbook-list")).not.toBeNull();

    panel.setWords(Object.freeze([saved(0)]));
    expect(root.querySelectorAll(".hnr-wordbook-row")).toHaveLength(1);
    expect(root.querySelector(".hnr-wordbook-summary")?.textContent).toBe("共 1 词 · 第 1 / 1 页");
  });

  it("explains how to collect words when the wordbook is empty", () => {
    document.body.innerHTML = '<section class="hnr-summary-pane"></section>';
    const root = document.querySelector<HTMLElement>(".hnr-summary-pane");
    if (!root) throw new Error("fixture missing root");
    new WordbookPanel(root, { onRemove: vi.fn(), onOpenSource: vi.fn(), lookup: fakeLookup() });
    expect(root.querySelector(".hnr-wordbook-empty")?.textContent).toContain("还没有收藏");
  });
});
