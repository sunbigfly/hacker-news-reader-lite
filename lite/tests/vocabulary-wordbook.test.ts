import { describe, expect, it } from "vitest";
import type { VocabularyWord } from "../src/vocabulary/model";
import {
  addWord,
  findSavedWord,
  readWordbook,
  removeWord,
  WORDBOOK_MAX_WORDS,
  WORDBOOK_STORAGE_KEY,
  type WordbookStorage,
} from "../src/vocabulary/wordbook";

function memoryStorage(initial?: unknown): WordbookStorage & { readonly value: () => unknown } {
  let stored: unknown = initial;
  return {
    read: (key, fallback) => (key === WORDBOOK_STORAGE_KEY ? stored ?? fallback : fallback),
    write: (key, value) => { if (key === WORDBOOK_STORAGE_KEY) stored = value; },
    value: () => stored,
  };
}

const WORD: VocabularyWord = Object.freeze({
  word: "counterintuitive",
  ipa: "/ˌkaʊntərɪnˈtuːɪtɪv/",
  meaning: "反直觉的",
  example: "The result was counterintuitive for everyone in the lab.",
  exampleMeaning: "这个结果对实验室里的每个人来说都反直觉。",
  level: "CET6+",
});

describe("wordbook storage", () => {
  it("adds a word with its source and reports the new total", () => {
    const storage = memoryStorage();
    expect(addWord(WORD, "https://news.ycombinator.com/item?id=1", { addedAt: 42, storage }))
      .toEqual({ added: true, total: 1 });
    expect(readWordbook(storage)).toEqual([{
      ...WORD,
      sourceUrl: "https://news.ycombinator.com/item?id=1",
      addedAt: 42,
    }]);
  });

  it("does not duplicate an already saved word", () => {
    const storage = memoryStorage();
    addWord(WORD, "https://news.ycombinator.com/item?id=1", { storage });
    expect(addWord(WORD, "https://news.ycombinator.com/item?id=2", { storage }))
      .toEqual({ added: false, total: 1 });
    expect(findSavedWord("COUNTERINTUITIVE", storage)?.sourceUrl).toBe("https://news.ycombinator.com/item?id=1");
  });

  it("removes a saved word and reports whether anything changed", () => {
    const storage = memoryStorage();
    addWord(WORD, "https://news.ycombinator.com/item?id=1", { storage });
    expect(removeWord("counterintuitive", storage)).toBe(true);
    expect(readWordbook(storage)).toEqual([]);
    expect(removeWord("counterintuitive", storage)).toBe(false);
  });

  it("refuses to grow past the wordbook limit", () => {
    const storage = memoryStorage(Array.from({ length: WORDBOOK_MAX_WORDS }, (_unused, index) => ({
      ...WORD,
      word: `word${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}`,
      sourceUrl: "https://news.ycombinator.com/item?id=1",
      addedAt: index,
    })));
    expect(readWordbook(storage)).toHaveLength(WORDBOOK_MAX_WORDS);
    expect(() => addWord(WORD, "https://news.ycombinator.com/item?id=1", { storage }))
      .toThrow(/已满/u);
  });

  it("treats corrupted or foreign stored values as an empty wordbook", () => {
    expect(readWordbook(memoryStorage("not an array"))).toEqual([]);
    expect(readWordbook(memoryStorage([null, 3, "word", { word: "x" }, { ...WORD, sourceUrl: "javascript:alert(1)", addedAt: 1 }]))).toEqual([]);
    expect(readWordbook({ read: () => { throw new Error("storage unavailable"); }, write: () => {} })).toEqual([]);
    expect(readWordbook(undefined)).toEqual([]);
  });
});
