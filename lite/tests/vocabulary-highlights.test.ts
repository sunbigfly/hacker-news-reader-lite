// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { VOCABULARY_INK_COLORS, VocabularyHighlights } from "../src/vocabulary/highlights";
import type { VocabularyWord } from "../src/vocabulary/model";

function word(overrides: Partial<VocabularyWord> = {}): VocabularyWord {
  return Object.freeze({
    word: "undermine",
    ipa: "/ˌʌndərˈmaɪn/",
    meaning: "削弱",
    example: "Late changes undermine a careful plan.",
    exampleMeaning: "后期的改动可能削弱周密的计划。",
    level: "CET6",
    ...overrides,
  });
}

const SOURCE = "Careless edits UNDERMINE a careful plan, and nothing else can undermine it faster. See <code>undermine()</code> for details.";

function fixture(): { root: HTMLElement; highlights: VocabularyHighlights } {
  document.body.innerHTML = `<div class="hnr-original-text">${SOURCE}</div>`;
  const root = document.querySelector<HTMLElement>(".hnr-original-text");
  if (!root) throw new Error("fixture missing root");
  return { root, highlights: new VocabularyHighlights() };
}

function marks(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("mark[data-vocabulary-ink]")];
}

describe("vocabulary highlights", () => {
  it("marks every occurrence of the exact word form, ignoring case", () => {
    const { root, highlights } = fixture();
    highlights.apply(root, [word()]);
    expect(marks(root).map((mark) => mark.textContent)).toEqual(["UNDERMINE", "undermine"]);
    expect(highlights.isMarked("undermine")).toBe(true);
  });

  it("leaves inflected forms alone, because only the model's exact form is highlighted", () => {
    document.body.innerHTML = '<div class="hnr-original-text">Nothing undermines a plan like careless edits.</div>';
    const root = document.querySelector<HTMLElement>(".hnr-original-text");
    if (!root) throw new Error("fixture missing root");
    new VocabularyHighlights().apply(root, [word()]);
    expect(marks(root)).toHaveLength(0);
  });

  it("restores the exact original text when highlights are cleared", () => {
    const { root, highlights } = fixture();
    const before = root.innerHTML;
    highlights.apply(root, [word()]);
    highlights.clear();
    expect(root.innerHTML).toBe(before);
    expect(highlights.isMarked("undermine")).toBe(false);
    expect(highlights.markCount).toBe(0);
  });

  it("marks words that end a paragraph, sit in an italic quote, or abut a link and code", () => {
    // Mirrors the real comment shape that looked unhighlighted: the word is last in its paragraph,
    // inside an italicised quote, and also appears beside a link and an inline code span.
    document.body.innerHTML = `<div class="hnr-original-text"><p><i>&gt; "When policy is politically polarized</i></p>
      <p>It seems in the world of politics, esp. populist politics, more facts don't bring better policies.</p>
      <p>See <a href="https://example.com">https://example.com/watch</a> and <code>polarized()</code>.</p></div>`;
    const root = document.querySelector<HTMLElement>(".hnr-original-text");
    if (!root) throw new Error("fixture missing root");
    const highlights = new VocabularyHighlights();
    highlights.apply(root, [
      word({ word: "polarized", meaning: "两极分化的" }),
      word({ word: "populist", meaning: "民粹主义的" }),
    ]);
    // The third occurrence sits inside <code>, which stays untouched by design.
    expect(marks(root).map((mark) => mark.textContent)).toEqual(["polarized", "populist"]);
    expect(root.querySelector("code")?.textContent).toBe("polarized()");
    expect(highlights.isMarked("populist")).toBe(true);
  });

  it("marks a word HN wrapped in inline markup, and every plain occurrence too", () => {
    // HN routinely wraps words in <i>, <a> and <code>, so a word can live in its own text node.
    document.body.innerHTML = `<div class="hnr-original-text">
      <p>Today, imitation of Agricola's <i>orthography</i> is used for humorous effect.</p>
      <p>The word vernacular appears plainly here.</p>
      <p>See <a href="https://example.com">collate</a> for the archive tool.</p>
      <p>Repeated: <b>vernacular</b> again in bold.</p>
    </div>`;
    const root = document.querySelector<HTMLElement>(".hnr-original-text");
    if (!root) throw new Error("fixture missing root");
    new VocabularyHighlights().apply(root, [
      word({ word: "orthography", meaning: "正字法" }),
      word({ word: "vernacular", meaning: "本土的" }),
      word({ word: "collate", meaning: "整理并核对" }),
    ]);
    expect(marks(root).map((mark) => mark.textContent))
      .toEqual(["orthography", "vernacular", "collate", "vernacular"]);
  });

  it("never marks code, script or preformatted text", () => {
    document.body.innerHTML = '<div class="hnr-original-text">undermine here<pre>undermine</pre><code>undermine</code><script>undermine</script></div>';
    const root = document.querySelector<HTMLElement>(".hnr-original-text");
    if (!root) throw new Error("fixture missing root");
    const highlights = new VocabularyHighlights();
    highlights.apply(root, [word()]);
    expect(marks(root)).toHaveLength(1);
    expect(root.querySelector("pre")?.textContent).toBe("undermine");
    expect(root.querySelector("code")?.textContent).toBe("undermine");
  });

  it("is idempotent across repeated applies and drops words that vanish", () => {
    const { root, highlights } = fixture();
    const before = root.innerHTML;
    highlights.apply(root, [word()]);
    highlights.apply(root, [word()]);
    expect(marks(root)).toHaveLength(2);

    highlights.apply(root, []);
    expect(marks(root)).toHaveLength(0);
    expect(root.innerHTML).toBe(before);
  });

  it("reports created marks to the caller and inks each one with its own colour", () => {
    const seen: HTMLElement[] = [];
    document.body.innerHTML = '<div class="hnr-original-text">undermine these plans</div>';
    const root = document.querySelector<HTMLElement>(".hnr-original-text");
    if (!root) throw new Error("fixture missing root");
    const highlights = new VocabularyHighlights((mark) => seen.push(mark));
    highlights.apply(root, [word()]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.dataset.vocabularyWord).toBe("undermine");
    expect(seen[0]?.getAttribute("aria-label")).toContain("削弱");
    // Ink is the reference brush, drawn as inline SVG: the colour rides on a custom property and the
    // two strokes are real elements, because the host CSP blocks the reference's data: image.
    expect(seen[0]?.style.getPropertyValue("--hnr-vocabulary-ink")).toBe(VOCABULARY_INK_COLORS[0]);
    // A data: image would be refused by `img-src 'self' https://account.ycombinator.com` on HN.
    expect(seen[0]?.style.backgroundImage).toBe("");
    expect(seen[0]?.style.getPropertyValue("background-image")).toBe("");
    const strokes = [...(seen[0]?.querySelectorAll("svg.hnr-vocabulary-brush path") ?? [])];
    expect(strokes).toHaveLength(2);
    expect(strokes.map((stroke) => stroke.getAttribute("stroke"))).toEqual([VOCABULARY_INK_COLORS[0], VOCABULARY_INK_COLORS[0]]);
    expect(strokes.map((stroke) => stroke.getAttribute("stroke-opacity"))).toEqual([".24", ".14"]);
    expect(VOCABULARY_INK_COLORS).toHaveLength(7);
  });

  it("keeps the word recoverable when a mark carries the brush", () => {
    const { root, highlights } = fixture();
    const before = root.innerHTML;
    highlights.apply(root, [word()]);
    // The inline brush adds elements, never text, so restoring a mark still yields the exact word.
    expect(marks(root).map((mark) => mark.textContent)).toEqual(["UNDERMINE", "undermine"]);
    expect(marks(root).every((mark) => mark.querySelector("svg.hnr-vocabulary-brush") !== null)).toBe(true);
    highlights.clear();
    expect(root.innerHTML).toBe(before);
  });

  it("inks every root it is given, and restores all of them", () => {
    // Bilingual mode renders one original section per paragraph, so a multi-paragraph comment has
    // several roots; inking only the first is what left the later paragraphs bare.
    document.body.innerHTML = '<div class="first">Careless edits can undermine a plan.</div><div class="second">Nothing else can undermine it faster.</div>';
    const roots = [...document.querySelectorAll<HTMLElement>(".first, .second")];
    const before = roots.map((root) => root.innerHTML);
    const highlights = new VocabularyHighlights();
    expect(highlights.apply(roots, [word()])).toHaveLength(2);
    expect(roots.map((root) => marks(root).length)).toEqual([1, 1]);
    // One colour per word, not per root: the same word keeps the same ink everywhere.
    expect(roots.map((root) => marks(root)[0]?.style.getPropertyValue("--hnr-vocabulary-ink")))
      .toEqual([VOCABULARY_INK_COLORS[0], VOCABULARY_INK_COLORS[0]]);
    expect(highlights.markCount).toBe(2);
    highlights.clear();
    expect(roots.map((root) => root.innerHTML)).toEqual(before);
    expect(highlights.markCount).toBe(0);
  });

  it("clears only the roots it still owns", () => {
    const { root, highlights } = fixture();
    highlights.apply(root, [word()]);
    root.remove();
    expect(() => highlights.clear()).not.toThrow();
    expect(highlights.markCount).toBe(0);
  });
});
