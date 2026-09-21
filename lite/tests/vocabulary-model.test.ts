import { describe, expect, it } from "vitest";
import {
  normalizeVocabularyWords,
  vocabularySourceText,
  VOCABULARY_MAX_SOURCE_CHARS,
  VOCABULARY_MAX_WORDS,
} from "../src/vocabulary/model";

const SOURCE = "The compiler emitted a subtly flawed optimization that undermined the whole benchmark, which is frankly counterintuitive.";

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    word: "counterintuitive",
    ipa: "/ˌkaʊntərɪnˈtuːɪtɪv/",
    meaning: "反直觉的",
    example: "The result was counterintuitive for everyone in the lab.",
    exampleMeaning: "这个结果对实验室里的每个人来说都反直觉。",
    level: "CET6+",
    ...overrides,
  };
}

describe("vocabulary model", () => {
  it("accepts a well-formed entry that is present in the comment", () => {
    expect(normalizeVocabularyWords([entry()], SOURCE)).toEqual([{
      word: "counterintuitive",
      ipa: "/ˌkaʊntərɪnˈtuːɪtɪv/",
      meaning: "反直觉的",
      example: "The result was counterintuitive for everyone in the lab.",
      exampleMeaning: "这个结果对实验室里的每个人来说都反直觉。",
      level: "CET6+",
    }]);
  });

  it("drops words that do not appear in the comment text", () => {
    expect(normalizeVocabularyWords([entry({ word: "ubiquitous" })], SOURCE)).toEqual([]);
  });

  it("rejects malformed words, non-Chinese meanings and missing translations", () => {
    const rejected = [
      entry({ word: "not a word" }),
      entry({ word: "x".repeat(41) }),
      entry({ meaning: "counterintuitive" }),
      entry({ exampleMeaning: "" }),
      entry({ exampleMeaning: undefined }),
      entry({ level: "CET4" }),
      entry({ level: undefined }),
      entry({ ipa: "" }),
      "counterintuitive",
      null,
    ];
    expect(normalizeVocabularyWords(rejected, SOURCE)).toEqual([]);
  });

  it("deduplicates case-insensitively, keeps order and caps the list", () => {
    const source = "Alpha beta gamma delta epsilon zeta eta theta iota kappa.";
    const words = ["Alpha", "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"].map((word) => entry({
      word,
      example: `${word} appears here in a sentence.`,
      exampleMeaning: `${word} 出现在这个句子里。`,
    }));
    const accepted = normalizeVocabularyWords(words, source);
    expect(accepted.map((word) => word.word)).toEqual(["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]);
    expect(accepted).toHaveLength(VOCABULARY_MAX_WORDS);
  });

  it("returns an empty list for a non-array answer and collapses source whitespace", () => {
    expect(normalizeVocabularyWords("counterintuitive", SOURCE)).toEqual([]);
    expect(vocabularySourceText("  a\n\n  b  ")).toBe("a b");
    expect(vocabularySourceText("x".repeat(VOCABULARY_MAX_SOURCE_CHARS + 50))).toHaveLength(VOCABULARY_MAX_SOURCE_CHARS);
  });
});
