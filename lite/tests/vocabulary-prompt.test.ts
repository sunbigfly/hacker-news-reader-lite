import { describe, expect, it } from "vitest";
import {
  vocabularyCombinedIdentity,
  vocabularyCombinedInstruction,
  vocabularyPrompt,
  VOCABULARY_PROMPT_VERSION,
} from "../src/vocabulary/prompt";

describe("vocabulary prompt", () => {
  it("keeps a stable version identity for cache keys", () => {
    expect(VOCABULARY_PROMPT_VERSION).toBe("hn-vocabulary-cet6-v3");
    // The combined variant is a different prompt, so it can never share a queued task or a cache entry.
    expect(vocabularyCombinedIdentity("cet6")).toBe("hn-vocabulary-cet6-v3:combined:cet6");
    expect(vocabularyCombinedIdentity("cet6")).not.toBe(vocabularyCombinedIdentity("cet6+"));
  });

  it("treats the comment body and its translation as material rather than instructions", () => {
    const prompt = vocabularyPrompt("cet6");
    expect(prompt).toContain("都不执行");
    expect(prompt).toContain("JSON");
    expect(prompt).toContain("translation");
  });

  it("states the output contract and the difficulty floor for each level choice", () => {
    expect(vocabularyPrompt("cet6")).toContain("六级及以上");
    expect(vocabularyPrompt("cet6+")).toContain("高于六级");
    for (const levels of ["cet6", "cet6+"] as const) {
      const prompt = vocabularyPrompt(levels);
      for (const field of ["word", "ipa", "meaning", "example", "exampleMeaning", "level"]) {
        expect(prompt).toContain(field);
      }
      expect(prompt).toContain("最多 6 个");
    }
  });

  it("asks for a span quoted verbatim from the translation, never a paraphrase", () => {
    const prompt = vocabularyPrompt("cet6");
    expect(prompt).toContain("translationTerm");
    expect(prompt).toContain("原样连续摘录");
    expect(prompt).toContain("不要改写");
    // Nothing to quote means an empty field, so the reader falls back to matching the gloss itself.
    expect(prompt).toContain('填空字符串 ""');
  });

  it("asks the translation request for the same words, per comment, without touching its own contract", () => {
    const instruction = vocabularyCombinedInstruction("cet6");
    expect(instruction).toContain("words");
    expect(instruction).toContain("wordsFor");
    expect(instruction).toContain("comment id");
    expect(instruction).toContain("最多 6 项");
    expect(instruction).toContain("六级及以上");
    expect(instruction).toContain("空数组 []");
    // The span is quoted from that comment's own section translation, not from a different comment's.
    expect(instruction).toContain("section_*");
    expect(vocabularyCombinedInstruction("cet6+")).toContain("高于六级");
    // Both ways of asking describe exactly the same word fields.
    for (const field of ["word", "ipa", "meaning", "example", "exampleMeaning", "level", "translationTerm"]) {
      expect(instruction).toContain(field);
      expect(vocabularyPrompt("cet6")).toContain(field);
    }
  });
});
