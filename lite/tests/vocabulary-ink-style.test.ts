// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { inkTarget, VocabularyHighlights } from "../src/vocabulary/highlights";

const CSS = readFileSync(resolve("lite/styles/10-reader.css"), "utf8");

interface Rule {
  readonly selector: string;
  readonly body: string;
  readonly specificity: number;
  readonly order: number;
}

/** Plain [ids, classes, elements] specificity per the cascade spec, as one comparable number. */
function specificity(selector: string): number {
  let ids = 0;
  let classes = 0;
  let elements = 0;
  let index = 0;
  while (index < selector.length) {
    const character = selector[index] ?? "";
    if (character === "#") {
      ids += 1;
      index += 1;
      while (/[\w-]/u.test(selector[index] ?? "")) index += 1;
      continue;
    }
    if (character === ".") {
      classes += 1;
      index += 1;
      while (/[\w-]/u.test(selector[index] ?? "")) index += 1;
      continue;
    }
    if (character === "[") {
      classes += 1;
      const close = selector.indexOf("]", index);
      index = close < 0 ? selector.length : close + 1;
      continue;
    }
    if (character === ":") {
      const pseudoElement = selector[index + 1] === ":";
      if (!pseudoElement) classes += 1;
      index += pseudoElement ? 2 : 1;
      while (/[\w-]/u.test(selector[index] ?? "")) index += 1;
      if (selector[index] === "(") {
        const close = selector.indexOf(")", index);
        const inner = selector.slice(index + 1, close < 0 ? selector.length : close);
        // :where/:is tolerate their arguments loosely here; this stylesheet only uses :host/:not.
        ids += (inner.match(/#[\w-]+/gu) ?? []).length;
        classes += (inner.match(/(^|[\s>+~,])\.[\w-]+/gu) ?? []).length;
        elements += (inner.match(/(^|[\s>+~,])[a-z][\w-]*/gu) ?? []).length;
        index = close < 0 ? selector.length : close + 1;
      }
      continue;
    }
    if (/[a-zA-Z*]/u.test(character)) {
      const start = index;
      while (/[\w-]/u.test(selector[index] ?? "")) index += 1;
      if (character !== "*") elements += 1;
      if (index === start) index += 1;
      continue;
    }
    index += 1;
  }
  return ids * 10_000 + classes * 100 + elements;
}

const RULES: readonly Rule[] = (() => {
  const source = CSS.replace(/\/\*[\s\S]*?\*\//gu, "");
  const rules: Rule[] = [];
  let order = 0;
  for (const match of source.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
    const body = match[2] ?? "";
    for (const selector of (match[1] ?? "").split(",")) {
      const trimmed = selector.trim();
      if (!trimmed || trimmed.startsWith("@")) continue;
      order += 1;
      rules.push({ selector: trimmed, body, specificity: specificity(trimmed), order });
    }
  }
  return rules;
})();

/** Mimics the cascade for one property: highest specificity wins, later rules break ties. */
function cascadeWinner(property: RegExp, matches: (selector: string) => boolean): Rule | undefined {
  return RULES
    .filter((rule) => matches(rule.selector) && property.test(rule.body))
    .sort((left, right) => left.specificity - right.specificity || left.order - right.order)
    .at(-1);
}

/** The mark lives in the comment body's original text, under the reader host theme scope. */
function selectsMark(selector: string): boolean {
  return /\[data-vocabulary-ink\]/u.test(selector) && !/data-theme/u.test(selector);
}

function cssRule(selector: string): Rule | undefined {
  return RULES.find((rule) => rule.selector === selector);
}

describe("vocabulary ink cascade", () => {
  it("counts specificity the way the cascade does, so the comparison below is meaningful", () => {
    // The mark rule must outrank the translation-theme rule that used to reset its decoration.
    const theme = ':host([data-translation-theme="underline"]) .hnr-bilingual-text .hnr-bilingual-translation-section';
    expect(specificity("mark[data-vocabulary-ink]")).toBe(101);
    expect(specificity(theme)).toBe(300);
    expect(specificity(".hnr-comment-body .hnr-original-text mark[data-vocabulary-ink]")).toBe(301);
  });

  it("keeps the mark neutral so the brush stroke is the only thing the reader sees", () => {
    const theme = ':host([data-translation-theme="underline"]) .hnr-bilingual-text .hnr-bilingual-translation-section';
    // The browser's own `mark` style paints a yellow band, and an earlier revision added a tinted band
    // plus an underline of ours; both would draw a second layer over the stroke.
    const band = cascadeWinner(/background-color\s*:/u, selectsMark);
    expect(band?.body).toContain("background-color: transparent");
    expect(band?.body).not.toContain("color-mix");
    const decoration = cascadeWinner(/text-decoration\s*:/u, selectsMark);
    expect(decoration?.body).toContain("text-decoration: none");
    expect(decoration?.body).not.toContain("text-decoration: underline");
    expect(cascadeWinner(/padding\s*:/u, selectsMark)?.body).toContain("padding: 0");
    // The neutralising rule must still outrank the translation-theme rule that decorates the section.
    expect(band?.specificity).toBeGreaterThanOrEqual(specificity(theme));
  });

  it("neutralises the mark in every copy the reader can be looking at", () => {
    const theme = ':host([data-translation-theme="underline"]) .hnr-bilingual-text .hnr-bilingual-translation-section';
    for (const copy of [".hnr-original-text", ".hnr-bilingual-original-section", ".hnr-bilingual-translation-section", ".hnr-translated-text"]) {
      const winner = cascadeWinner(/background-color\s*:/u, (selector) => selectsMark(selector) && selector.includes(copy));
      // Bilingual mode rebuilds the text from the translation payload, and translated-only mode shows
      // just the Chinese, so each of those copies needs the same "no band, no underline" rule.
      expect(winner?.body, copy).toContain("background-color: transparent");
      expect(winner?.specificity, copy).toBeGreaterThanOrEqual(specificity(theme));
    }
  });

  it("paints a wrapped mark with per-fragment backgrounds instead of the single brush child", () => {
    const wrapped = cssRule("mark[data-vocabulary-ink][data-vocabulary-wrap]");
    // The brush is one child and can only sit behind one line box, so a wrapped mark is painted by the
    // stylesheet; `box-decoration-break: clone` is what repeats the ink on every fragment.
    expect(cssRule("mark[data-vocabulary-ink]")?.body).toContain("position: relative");
    expect(wrapped?.body).toContain("linear-gradient");
    expect(wrapped?.body).toContain("background-repeat: no-repeat");
    // Gradients are not fetched images: the host CSP that blocks the reference's data: URL allows them.
    expect(wrapped?.body).not.toContain("data:");
    expect(wrapped?.body).not.toContain("url(");
    // Two gradients stand in for the reference's two strokes, at its own strengths.
    expect(wrapped?.body).toContain("24%");
    expect(wrapped?.body).toContain("14%");
    expect(cssRule("mark[data-vocabulary-ink][data-vocabulary-wrap] > .hnr-vocabulary-brush")?.body)
      .toContain("display: none");
    // A wrapped mark stays neutral: the ink is the gradient, never a box.
    expect(cascadeWinner(/background-color\s*:/u, selectsMark)?.body).toContain("background-color: transparent");
  });

  it("draws the reference brush as inline SVG, because the host CSP blocks data: images", () => {
    document.body.innerHTML = '<div class="hnr-comment-body"><div class="hnr-original-text">Maybe local AGI isn\'t so far-fetched.</div></div>';
    const original = document.querySelector<HTMLElement>(".hnr-original-text");
    if (!original) throw new Error("fixture missing root");
    const seen: HTMLElement[] = [];
    new VocabularyHighlights((mark) => seen.push(mark)).apply([inkTarget(original)], [{
      word: "far-fetched",
      ipa: "/ˌfɑːr ˈfetʃt/",
      meaning: "牵强的",
      example: "It sounded far-fetched.",
      exampleMeaning: "听起来很牵强。",
      level: "CET6",
    }]);
    const mark = seen[0];
    if (!mark) throw new Error("mark was not created");
    expect(mark.textContent).toBe("far-fetched");
    expect(mark.style.textDecoration).toBe("");
    expect(mark.style.getPropertyValue("--hnr-vocabulary-ink")).toBe("#d95d7f");
    // news.ycombinator.com answers with `img-src 'self' https://account.ycombinator.com`; a data: URL is
    // refused there, which is why the reference's background brush stayed invisible.
    expect(mark.style.backgroundImage).toBe("");
    const brush = mark.querySelector("svg.hnr-vocabulary-brush");
    expect(brush?.getAttribute("viewBox")).toBe("0 0 100 16");
    expect(brush?.getAttribute("preserveAspectRatio")).toBe("none");
    expect(brush?.getAttribute("aria-hidden")).toBe("true");
    // The reference draws two overlapping strokes, both carrying the word's own ink colour.
    const strokes = [...(brush?.querySelectorAll("path") ?? [])];
    expect(strokes.map((stroke) => stroke.getAttribute("stroke-opacity"))).toEqual([".24", ".14"]);
    expect(strokes.map((stroke) => stroke.getAttribute("stroke-width"))).toEqual(["8", "3"]);
    expect(strokes.every((stroke) => stroke.getAttribute("stroke") === "#d95d7f")).toBe(true);
    // The brush is painted behind the letters, not over them.
    expect(cssRule("mark[data-vocabulary-ink]")?.body).toContain("isolation: isolate");
    const placed = cssRule("mark[data-vocabulary-ink] > .hnr-vocabulary-brush");
    expect(placed?.body).toContain("z-index: -1");
    expect(placed?.body).toContain("position: absolute");
  });
});
