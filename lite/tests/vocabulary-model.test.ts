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

  it("keeps a Chinese span only when the model quoted it from the translation the reader sees", () => {
    const translation = "这个结果对实验室里的每个人来说都反直觉，因此编译器悄悄削弱了基准测试。";
    const quoted = normalizeVocabularyWords([entry({ translationTerm: "反直觉" })], SOURCE, translation);
    expect(quoted[0]?.translationTerm).toBe("反直觉");
    // A shorter verbatim quote is the model's own choice of span, so it is kept as written.
    expect(normalizeVocabularyWords([entry({ translationTerm: "直觉" })], SOURCE, translation)[0]?.translationTerm).toBe("直觉");

    const rejected = [
      // Paraphrases, re-translations and invented phrases are dropped, never marked.
      entry({ translationTerm: "违反直觉的" }),
      entry({ translationTerm: "反直觉的" }),
      entry({ translationTerm: "反直觉的英文" }),
      // A single character is not a claim about one word.
      entry({ translationTerm: "反" }),
      entry({ translationTerm: "" }),
      entry({ translationTerm: 42 }),
    ];
    for (const value of rejected) {
      expect(normalizeVocabularyWords([value], SOURCE, translation)[0]?.translationTerm).toBeUndefined();
    }
    // Without a translation there is nothing the model could have quoted, so no span survives.
    expect(normalizeVocabularyWords([entry({ translationTerm: "反直觉" })], SOURCE)[0]?.translationTerm).toBeUndefined();
  });

  it("returns an empty list for a non-array answer and collapses source whitespace", () => {
    expect(normalizeVocabularyWords("counterintuitive", SOURCE)).toEqual([]);
    expect(vocabularySourceText("  a\n\n  b  ")).toBe("a b");
    expect(vocabularySourceText("x".repeat(VOCABULARY_MAX_SOURCE_CHARS + 50))).toHaveLength(VOCABULARY_MAX_SOURCE_CHARS);
  });
});
