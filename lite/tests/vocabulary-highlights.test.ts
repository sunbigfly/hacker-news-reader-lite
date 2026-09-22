// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { inkTarget, VOCABULARY_INK_COLORS, VocabularyHighlights } from "../src/vocabulary/highlights";
import type { VocabularyWord } from "../src/vocabulary/model";

afterEach(() => {
  // Property-level stubs from one case must not leak into the next.
  Reflect.deleteProperty(HTMLElement.prototype, "getClientRects");
});

/** jsdom lays nothing out, so a test that cares about wrapping declares how many line boxes to report. */
function stubClientRects(count: number): void {
  Object.defineProperty(HTMLElement.prototype, "getClientRects", {
    configurable: true,
    value: () => Array.from({ length: count }, () => ({ width: 40, height: 18 }) as DOMRect),
  });
}

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
    highlights.apply([inkTarget(root)], [word()]);
    expect(marks(root).map((mark) => mark.textContent)).toEqual(["UNDERMINE", "undermine"]);
    expect(highlights.isMarked("undermine")).toBe(true);
  });

  it("leaves inflected forms alone, because only the model's exact form is highlighted", () => {
    document.body.innerHTML = '<div class="hnr-original-text">Nothing undermines a plan like careless edits.</div>';
    const root = document.querySelector<HTMLElement>(".hnr-original-text");
    if (!root) throw new Error("fixture missing root");
    new VocabularyHighlights().apply([inkTarget(root)], [word()]);
    expect(marks(root)).toHaveLength(0);
  });

  it("marks a span that an earlier unwrap split across text nodes", () => {
    // Unwrapping the gloss mark 「工程」 leaves the word in its own node, so the text reads 「工程」+「学…」;
    // searching node by node would never find 「工程学」 again.
    document.body.innerHTML = '<div class="zh">工程学评论解释了详细的软件实践。</div>';
    const zh = document.querySelector<HTMLElement>(".zh");
    if (!zh) throw new Error("fixture missing root");
    const highlights = new VocabularyHighlights();
    const engineering: VocabularyWord = {
      word: "engineering",
      ipa: "/ˌendʒɪˈnɪərɪŋ/",
      meaning: "工程",
      example: "Software engineering rewards readers.",
      exampleMeaning: "软件工程会奖励读者。",
      level: "CET6",
    };
    highlights.apply([inkTarget(zh, "zh")], [engineering]);
    expect(marks(zh).map((mark) => mark.textContent)).toEqual(["工程"]);
    highlights.clear();
    // Clearing merges the restored word back, so the copy looks exactly as it did before.
    expect(zh.childNodes).toHaveLength(1);

    highlights.apply([inkTarget(zh, "zh")], [{ ...engineering, translationTerm: "工程学" }]);
    expect(marks(zh).map((mark) => mark.textContent)).toEqual(["工程学"]);
    expect(zh.textContent).toBe("工程学评论解释了详细的软件实践。");
  });

  it("marks a span that inline markup splits in the source itself", () => {
    document.body.innerHTML = '<div class="zh">这是数字版<b>莫蒂</b>与死亡水晶对话。</div>';
    const zh = document.querySelector<HTMLElement>(".zh");
    if (!zh) throw new Error("fixture missing root");
    new VocabularyHighlights().apply([inkTarget(zh, "zh")], [word({
      word: "equivalent",
      meaning: "对应物；等价物",
      translationTerm: "版莫蒂",
    })]);
    const found = marks(zh);
    // The span crosses the inline element, so it becomes one mark per element — painting the same span.
    expect(found.map((mark) => mark.textContent)).toEqual(["版", "莫蒂"]);
    expect(found.every((mark) => mark.dataset.vocabularyLang === "zh")).toBe(true);
    expect(zh.textContent).toBe("这是数字版莫蒂与死亡水晶对话。");
  });

  it("restores the exact original text when highlights are cleared", () => {
    const { root, highlights } = fixture();
    const before = root.innerHTML;
    highlights.apply([inkTarget(root)], [word()]);
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
    highlights.apply([inkTarget(root)], [
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
    new VocabularyHighlights().apply([inkTarget(root)], [
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
    highlights.apply([inkTarget(root)], [word()]);
    expect(marks(root)).toHaveLength(1);
    expect(root.querySelector("pre")?.textContent).toBe("undermine");
    expect(root.querySelector("code")?.textContent).toBe("undermine");
  });

  it("is idempotent across repeated applies and drops words that vanish", () => {
    const { root, highlights } = fixture();
    const before = root.innerHTML;
    highlights.apply([inkTarget(root)], [word()]);
    highlights.apply([inkTarget(root)], [word()]);
    expect(marks(root)).toHaveLength(2);

    highlights.apply([inkTarget(root)], []);
    expect(marks(root)).toHaveLength(0);
    expect(root.innerHTML).toBe(before);
  });

  it("reports created marks to the caller and inks each one with its own colour", () => {
    const seen: HTMLElement[] = [];
    document.body.innerHTML = '<div class="hnr-original-text">undermine these plans</div>';
    const root = document.querySelector<HTMLElement>(".hnr-original-text");
    if (!root) throw new Error("fixture missing root");
    const highlights = new VocabularyHighlights((mark) => seen.push(mark));
    highlights.apply([inkTarget(root)], [word()]);
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
    highlights.apply([inkTarget(root)], [word()]);
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
    expect(highlights.apply(roots.map((root) => inkTarget(root)), [word()])).toHaveLength(2);
    expect(roots.map((root) => marks(root).length)).toEqual([1, 1]);
    // One colour per word, not per root: the same word keeps the same ink everywhere.
    expect(roots.map((root) => marks(root)[0]?.style.getPropertyValue("--hnr-vocabulary-ink")))
      .toEqual([VOCABULARY_INK_COLORS[0], VOCABULARY_INK_COLORS[0]]);
    expect(highlights.markCount).toBe(2);
    highlights.clear();
    expect(roots.map((root) => root.innerHTML)).toEqual(before);
    expect(highlights.markCount).toBe(0);
  });

  it("inks the span the model quoted, even when the gloss shares no wording with it", () => {
    // "the digital equivalent of Morty" is 「数字版莫蒂」: neither 对应物 nor 等价物 appears there, so
    // only the quoted span can find it.
    document.body.innerHTML = '<div class="zh">这是数字版莫蒂与死亡水晶对话。</div>';
    const zh = document.querySelector<HTMLElement>(".zh");
    if (!zh) throw new Error("fixture missing root");
    new VocabularyHighlights().apply([inkTarget(zh, "zh")], [word({
      word: "equivalent",
      meaning: "对应物；等价物",
      translationTerm: "数字版",
    })]);
    expect(marks(zh).map((mark) => mark.textContent)).toEqual(["数字版"]);
  });

  it("falls back to the gloss when the quoted span is gone from the translation on screen", () => {
    // A re-translation replaces the span the model quoted, so the gloss matcher takes over.
    document.body.innerHTML = '<div class="zh">硬件难以接近。</div>';
    const zh = document.querySelector<HTMLElement>(".zh");
    if (!zh) throw new Error("fixture missing root");
    new VocabularyHighlights().apply([inkTarget(zh, "zh")], [word({
      word: "inaccessible",
      meaning: "难以接近的",
      translationTerm: "无法进入",
    })]);
    expect(marks(zh).map((mark) => mark.textContent)).toEqual(["难以接近"]);
  });

  it("marks the Chinese span a gloss shares with the translation, in the word's own colour", () => {
    document.body.innerHTML = '<div class="en">Hardware stays inaccessible to most people.</div>'
      + '<div class="zh">硬件对大多数人来说仍然难以接近。</div>';
    const en = document.querySelector<HTMLElement>(".en");
    const zh = document.querySelector<HTMLElement>(".zh");
    if (!en || !zh) throw new Error("fixture missing roots");
    const highlights = new VocabularyHighlights();
    highlights.apply([inkTarget(en), inkTarget(zh, "zh")], [word({ word: "inaccessible", meaning: "难以理解的，难以接近的" })]);

    const [enMark] = marks(en);
    const [zhMark] = marks(zh);
    expect(zhMark?.textContent).toBe("难以接近");
    expect(zhMark?.dataset.vocabularyWord).toBe("inaccessible");
    expect(zhMark?.dataset.vocabularyLang).toBe("zh");
    expect(enMark?.dataset.vocabularyLang).toBe("en");
    // Same word, same ink, and the same card: the pair reads as one vocabulary item.
    expect(zhMark?.style.getPropertyValue("--hnr-vocabulary-ink"))
      .toBe(enMark?.style.getPropertyValue("--hnr-vocabulary-ink"));
    expect(zhMark?.getAttribute("aria-label")).toBe(enMark?.getAttribute("aria-label"));
    expect(zhMark?.querySelector("svg.hnr-vocabulary-brush")).not.toBeNull();
  });

  it("leaves a Chinese copy untouched when no gloss wording appears in it", () => {
    document.body.innerHTML = '<div class="zh">数据中心风潮将以市场崩溃结束。</div>';
    const zh = document.querySelector<HTMLElement>(".zh");
    if (!zh) throw new Error("fixture missing root");
    const before = zh.innerHTML;
    new VocabularyHighlights().apply([inkTarget(zh, "zh")], [word({ word: "furore", meaning: "公愤；轩然大波" })]);
    expect(marks(zh)).toHaveLength(0);
    expect(zh.innerHTML).toBe(before);
  });

  it("never claims the English word in the Chinese copy, nor the gloss in the English one", () => {
    document.body.innerHTML = '<div class="en">Nothing to see here.</div><div class="zh">这里没有任何对应词。</div>';
    const en = document.querySelector<HTMLElement>(".en");
    const zh = document.querySelector<HTMLElement>(".zh");
    if (!en || !zh) throw new Error("fixture missing roots");
    // The gloss is 「削弱」 and the English word is 「undermine」: each language only claims its own.
    new VocabularyHighlights().apply([inkTarget(en), inkTarget(zh, "zh")], [word()]);
    expect(marks(en)).toHaveLength(0);
    expect(marks(zh)).toHaveLength(0);
  });

  it("restores both copies exactly when cleared", () => {
    document.body.innerHTML = '<div class="en">Hardware stays inaccessible.</div><div class="zh">硬件难以接近。</div>';
    const roots = [...document.querySelectorAll<HTMLElement>(".en, .zh")];
    const [en, zh] = roots;
    if (!en || !zh) throw new Error("fixture missing roots");
    const before = roots.map((root) => root.innerHTML);
    const highlights = new VocabularyHighlights();
    highlights.apply([inkTarget(en), inkTarget(zh, "zh")], [word({ word: "inaccessible", meaning: "难以接近的" })]);
    expect(highlights.markCount).toBe(2);
    highlights.clear();
    expect(roots.map((root) => root.innerHTML)).toEqual(before);
  });

  it("paints a wrapped mark from the stylesheet and a single-line mark with the brush", () => {
    // A mark that spans two lines has one box per line; the brush is a single child that can only sit
    // behind one of them, so a wrapped mark is flagged for the stylesheet's per-fragment background.
    document.body.innerHTML = '<div class="zh">这是数字版莫蒂与死亡水晶对话。</div>';
    const zh = document.querySelector<HTMLElement>(".zh");
    if (!zh) throw new Error("fixture missing root");
    const highlights = new VocabularyHighlights();
    const target = inkTarget(zh, "zh");
    const equivalent = word({ word: "equivalent", meaning: "对应物；等价物", translationTerm: "数字版" });

    stubClientRects(2);
    highlights.apply([target], [equivalent]);
    const wrapped = marks(zh)[0];
    expect(wrapped?.dataset.vocabularyWrap).toBe("line");
    expect(wrapped?.querySelector("svg.hnr-vocabulary-brush")).toBeNull();
    // The colour still rides on the mark: the stylesheet builds its gradients from it.
    expect(wrapped?.style.getPropertyValue("--hnr-vocabulary-ink")).toMatch(/^#/);
    highlights.clear();

    stubClientRects(1);
    highlights.apply([target], [equivalent]);
    const single = marks(zh)[0];
    expect(single?.dataset.vocabularyWrap).toBeUndefined();
    expect(single?.querySelector("svg.hnr-vocabulary-brush")).not.toBeNull();
  });

  it("restores a wrapped mark to plain text like any other", () => {
    document.body.innerHTML = '<div class="zh">这里难以接近。</div>';
    const zh = document.querySelector<HTMLElement>(".zh");
    if (!zh) throw new Error("fixture missing root");
    const before = zh.innerHTML;
    stubClientRects(2);
    const highlights = new VocabularyHighlights();
    highlights.apply([inkTarget(zh, "zh")], [word({ word: "inaccessible", meaning: "难以接近的" })]);
    expect(marks(zh)).toHaveLength(1);
    highlights.clear();
    expect(zh.innerHTML).toBe(before);
  });

  it("clears only the roots it still owns", () => {
    const { root, highlights } = fixture();
    highlights.apply([inkTarget(root)], [word()]);
    root.remove();
    expect(() => highlights.clear()).not.toThrow();
    expect(highlights.markCount).toBe(0);
  });
});
