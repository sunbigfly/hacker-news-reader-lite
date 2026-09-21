// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { VocabularySection } from "../src/vocabulary/comment-vocabulary";
import type { VocabularyWord } from "../src/vocabulary/model";
import { readWordbook, WORDBOOK_STORAGE_KEY, type WordbookStorage } from "../src/vocabulary/wordbook";

const SOURCE_URL = "https://news.ycombinator.com/item?id=42";

function word(word: string, level: VocabularyWord["level"] = "CET6"): VocabularyWord {
  return Object.freeze({
    word,
    ipa: `/${word}/`,
    meaning: `${word} 的释义`,
    example: `An example with ${word} inside.`,
    exampleMeaning: `一个包含 ${word} 的例句。`,
    level,
  });
}

function mount(options: Partial<ConstructorParameters<typeof VocabularySection>[1]> = {}): {
  readonly root: HTMLElement;
  readonly section: VocabularySection;
  readonly onSaved: () => void;
} {
  document.body.innerHTML = '<article class="hnr-comment-body"></article><div class="hnr-vocabulary"></div>';
  const root = document.querySelector<HTMLElement>(".hnr-vocabulary");
  if (!root) throw new Error("fixture missing root");
  const onSaved = vi.fn();
  const section = new VocabularySection(root, { sourceUrl: SOURCE_URL, onSaved, ...options });
  return { root, section, onSaved };
}

let storage: WordbookStorage & { readonly value: () => unknown };
beforeEach(() => {
  let stored: unknown;
  storage = {
    read: (key, fallback) => (key === WORDBOOK_STORAGE_KEY ? stored ?? fallback : fallback),
    write: (key, value) => { if (key === WORDBOOK_STORAGE_KEY) stored = value; },
    value: () => stored,
  };
  vi.stubGlobal("GM_getValue", (key: string, fallback: unknown) => storage.read(key, fallback));
  vi.stubGlobal("GM_setValue", (key: string, value: unknown) => storage.write(key, value));
});

describe("comment vocabulary section", () => {
  it("starts hidden and empty so an untouched comment keeps its height", () => {
    const { root } = mount();
    expect(root.hidden).toBe(true);
    expect(root.dataset.vocabularyState).toBe("empty");
    expect(root.querySelector(".hnr-vocabulary-status")?.textContent).toBe("");
  });

  it("shows only the word rows, with no heading text of its own", () => {
    const { root, section } = mount();
    section.setWords([word("undermine")]);
    expect(root.hidden).toBe(false);
    expect(root.dataset.vocabularyState).toBe("ready");
    const row = root.querySelector<HTMLElement>('[data-vocabulary-row="undermine"]');
    expect(row?.querySelector(".hnr-word-label")?.textContent).toBe("undermine");
    expect(row?.querySelector(".hnr-word-ipa")?.textContent).toBe("/undermine/");
    expect(row?.querySelector(".hnr-word-meaning")?.textContent).toBe("undermine 的释义");
    expect(row?.querySelector(".hnr-word-sound")).not.toBeNull();
    expect(row?.querySelector(".hnr-word-bookmark")).not.toBeNull();
    // The separator is drawn by a pseudo-element, so no header text and no count row is rendered.
    expect(root.querySelector("legend")).toBeNull();
    expect(root.textContent).not.toContain("评论词汇");
    expect(root.querySelector(".hnr-vocabulary-message")).toBeNull();
    expect(root.textContent).toBe("undermine/undermine/undermine 的释义");
  });

  it("collapses beyond three words until the reader expands them", () => {
    const { root, section } = mount();
    section.setWords(["alpha", "beta", "gamma", "delta", "epsilon"].map((name) => word(name)));
    const rows = [...root.querySelectorAll<HTMLElement>("[data-vocabulary-row]")];
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.hidden)).toEqual([false, false, false, true, true]);
    // No count line: the expand control is the only chrome the section adds.
    expect(root.querySelector(".hnr-vocabulary-message")).toBeNull();
    expect(root.textContent).not.toContain("悬停查看释义");
    const more = root.querySelector<HTMLButtonElement>(".hnr-vocabulary-more");
    expect(more?.hidden).toBe(false);
    expect(more?.textContent).toBe("展开其余 2 词");
    more?.click();
    expect([...root.querySelectorAll<HTMLElement>("[data-vocabulary-row]")].map((row) => row.hidden))
      .toEqual([false, false, false, false, false]);
    expect(more?.textContent).toBe("收起");
    expect(more?.getAttribute("aria-expanded")).toBe("true");
  });

  it("saves a word into the wordbook and reports it once", () => {
    const { root, section, onSaved } = mount();
    section.setWords([word("undermine")]);
    root.querySelector<HTMLButtonElement>(".hnr-word-bookmark")?.click();
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(readWordbook(storage)).toEqual([expect.objectContaining({ word: "undermine", sourceUrl: SOURCE_URL })]);
    expect(root.querySelector(".hnr-word-bookmark")?.getAttribute("aria-pressed")).toBe("true");

    section.setWords([word("undermine")]);
    expect(root.querySelector(".hnr-word-bookmark")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("does not open a hover card when the viewport cannot hover", () => {
    const openWordPopup = vi.fn(() => () => {});
    const { root, section } = mount();
    section.setWords([word("undermine")]);
    const label = root.querySelector<HTMLElement>(".hnr-word-label");
    label?.dispatchEvent(new MouseEvent("pointerenter"));
    expect(openWordPopup).not.toHaveBeenCalled();
    expect(label?.tabIndex).toBe(-1);
  });

  it("reports a save failure without losing the word list", () => {
    vi.stubGlobal("GM_setValue", () => { throw new Error("quota exceeded"); });
    const { root, section } = mount();
    section.setWords([word("undermine")]);
    root.querySelector<HTMLButtonElement>(".hnr-word-bookmark")?.click();
    expect(root.querySelector(".hnr-vocabulary-status")?.textContent).toBe("quota exceeded");
    expect(section.words).toHaveLength(1);
  });

  it("shows an error state and can be destroyed back to an empty hidden section", () => {
    const { root, section } = mount();
    section.setError("词汇响应格式错误");
    expect(root.hidden).toBe(false);
    expect(root.dataset.vocabularyState).toBe("error");
    expect(root.querySelector(".hnr-vocabulary-status")?.textContent).toBe("词汇响应格式错误");
    expect(section.words).toHaveLength(0);
    section.destroy();
    expect(root.hidden).toBe(true);
    expect(root.childElementCount).toBe(0);
  });

  it("condenses the unconfigured-AI message instead of repeating it on every comment", () => {
    const { root, section } = mount();
    section.setError("请先配置 AI API Key 与模型");
    expect(root.querySelector(".hnr-vocabulary-status")?.textContent)
      .toBe("词汇整理未配置 AI，请在阅读设置中填写 Base URL、API Key 与模型。");
  });
});
