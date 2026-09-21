// @vitest-environment node

import { describe, expect, it } from "vitest";
import { localWord, wordFormParts, wordTagLabels, WORD_FORM_LABELS, WORD_TAG_LABELS } from "../src/vocabulary/ecdict";

describe("offline word list", () => {
  it("labels the exam tags the reader shows", () => {
    expect(WORD_TAG_LABELS.cet6).toBe("CET6");
    expect(wordTagLabels(["cet4", "ky", "unknown-tag"])).toEqual(["CET4", "考研", "unknown-tag"]);
    expect(wordTagLabels([])).toEqual([]);
  });

  it("turns ECDICT exchange codes into readable word forms, skipping unknown codes", () => {
    expect(WORD_FORM_LABELS.p).toBe("过去式");
    expect(wordFormParts("p:went/d:gone/3:goes")).toEqual(["过去式 went", "过去分词 gone", "第三人称 goes"]);
    expect(wordFormParts("i:going/zz:broken/0:")).toEqual(["现在分词 going"]);
    expect(wordFormParts("")).toEqual([]);
  });

  it("answers a common word from the gzipped list after one inflation", async () => {
    const [first, second] = await Promise.all([localWord("abandon"), localWord("Abandon")]);
    expect(first?.word.toLowerCase()).toBe("abandon");
    expect(first?.meaning).toBeTruthy();
    expect(second?.word).toBe(first?.word);
  });

  it("returns undefined for a word the list does not hold", async () => {
    expect(await localWord("zzzznotawordzzzz")).toBeUndefined();
  });
});
