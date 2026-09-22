import { describe, expect, it } from "vitest";
import { glossPattern, glossRuns, glossTerms } from "../src/vocabulary/gloss";

describe("gloss matching", () => {
  it("takes Han runs of two characters or more and drops the parentheticals", () => {
    expect(glossRuns("公愤；轩然大波")).toEqual(["公愤", "轩然大波"]);
    expect(glossRuns("难以理解的，难以接近的")).toEqual(["难以理解的", "难以接近的"]);
    expect(glossRuns("哥特体（Fraktur）")).toEqual(["哥特体"]);
    // A single character matches far too much to be a claim about one word.
    expect(glossRuns("的；了")).toEqual([]);
  });

  it("finds the span a gloss shares with the sentence, walking down from the longest run", () => {
    // The AI writes the gloss, the translation service writes the sentence, so they never share
    // wording exactly: 「难以接近的」 has to find 「难以接近」.
    expect(glossTerms("难以理解的，难以接近的", "因为它感觉难以接近。")).toEqual(["难以接近"]);
    expect(glossTerms("引起兴趣，使好奇", "这让我很感兴趣。")).toEqual(["兴趣"]);
    expect(glossTerms("市场", "数据中心风潮将以市场崩溃结束。")).toEqual(["市场"]);
  });

  it("prefers the longest shared span over the shorter one an earlier run could offer", () => {
    // 「难以」 also occurs, and comes from the first run, but 「难以接近」 is the better claim.
    expect(glossTerms("难以理解的，难以接近的", "研究难以接近，文字也难以接近。")).toEqual(["难以接近"]);
    expect(glossTerms("正字法；拼写系统", "十九世纪，正字法改为使用 V。")).toEqual(["正字法"]);
    // Only spans anchored to a gloss phrase are claimed, so 「换使用」 never wins over 「互换」.
    expect(glossTerms("可互换地；可交换使用地", "两者可以互换使用。")).toEqual(["互换"]);
  });

  it("never claims a span that straddles two words of the sentence", () => {
    // 「换使用」 sits between 「互换」 and 「使用」, and is not a word of either gloss.
    expect(glossTerms("可互换地；可交换使用地", "两者可以互换使用。")).not.toContain("换使用");
    // A gloss phrase keeps its own boundary: 「兴趣」 is a suffix of 「引起兴趣」, not a middle slice.
    expect(glossTerms("引起兴趣，使好奇", "这让我很感兴趣。")).toEqual(["兴趣"]);
  });

  it("claims nothing when the gloss and the sentence share no wording", () => {
    expect(glossTerms("公愤；轩然大波", "数据中心风潮将以市场崩溃结束。")).toEqual([]);
    expect(glossTerms("削弱", "Everything else stayed the same.")).toEqual([]);
    expect(glossTerms("削弱", "")).toEqual([]);
  });

  it("marks every occurrence of the span it settled on", () => {
    const pattern = glossPattern("难以理解的，难以接近的", "难以接近，但也难以接近地说明。");
    expect(pattern?.source).toBe("难以接近");
    expect([..."难以接近，但也难以接近地说明。".matchAll(pattern ?? /$^/u)].length).toBe(2);
    expect(glossPattern("公愤；轩然大波", "数据中心风潮将以市场崩溃结束。")).toBeNull();
  });

  it("keeps at most one claim, so a word never speckles a whole paragraph", () => {
    expect(glossTerms("市场；风潮；崩溃", "市场风潮导致崩溃。")).toEqual(["市场"]);
  });

  it("returns nothing for a gloss with no Han characters of its own", () => {
    expect(glossPattern("a+b", "a+b")).toBeNull();
  });
});
