// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { VocabularyHighlights } from "../src/vocabulary/highlights";

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

  it("keeps the mark neutral so the ported brush stroke is what the reader sees", () => {
    const mark = cascadeWinner(/text-decoration\s*:/u, selectsMark);
    expect(mark?.body).toContain("text-decoration: underline");
    // The band and underline are the guaranteed floor if the brush image never paints, and the
    // scoped selector must outrank the translation-theme rule that decorates an ancestor path.
    const theme = ':host([data-translation-theme="underline"]) .hnr-bilingual-text .hnr-bilingual-translation-section';
    expect(mark?.specificity).toBeGreaterThanOrEqual(specificity(theme));
  });

  it("inks the copy bilingual mode shows, not only the hidden original element", () => {
    const theme = ':host([data-translation-theme="underline"]) .hnr-bilingual-text .hnr-bilingual-translation-section';
    const winner = cascadeWinner(/background-color\s*:/u, (selector) => selectsMark(selector) && selector.includes(".hnr-bilingual-original-section"));
    // The bilingual block is built from the translation payload, so its original section is the only
    // place the ink can live while the reader is looking at that copy.
    expect(winner?.body).toContain("text-decoration: underline");
    expect(winner?.specificity).toBeGreaterThanOrEqual(specificity(theme));
  });

  it("draws the reference brush as inline SVG, because the host CSP blocks data: images", () => {
    document.body.innerHTML = '<div class="hnr-comment-body"><div class="hnr-original-text">Maybe local AGI isn\'t so far-fetched.</div></div>';
    const original = document.querySelector<HTMLElement>(".hnr-original-text");
    if (!original) throw new Error("fixture missing root");
    const seen: HTMLElement[] = [];
    new VocabularyHighlights((mark) => seen.push(mark)).apply(original, [{
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
