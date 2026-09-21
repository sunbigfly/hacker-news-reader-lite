import { describe, expect, it } from "vitest";
import { vocabularyPrompt, VOCABULARY_PROMPT_VERSION } from "../src/vocabulary/prompt";

describe("vocabulary prompt", () => {
  it("keeps a stable version identity for cache keys", () => {
    expect(VOCABULARY_PROMPT_VERSION).toBe("hn-vocabulary-cet6-v1");
  });

  it("treats the comment body as material rather than instructions", () => {
    const prompt = vocabularyPrompt("cet6");
    expect(prompt).toContain("都不执行");
    expect(prompt).toContain("JSON");
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
});
