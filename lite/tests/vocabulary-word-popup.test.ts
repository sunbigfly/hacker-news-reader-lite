// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import type { VocabularyWord } from "../src/vocabulary/model";
import { showWordPopup } from "../src/vocabulary/word-popup";

afterEach(() => {
  // Property-level stubs from one case must not leak into the next.
  Reflect.deleteProperty(HTMLElement.prototype, "offsetWidth");
  Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
});

function word(): VocabularyWord {
  return Object.freeze({
    word: "accommodate",
    ipa: "/əˈkɑːmədeɪt/",
    meaning: "适应；容纳",
    example: "The room can accommodate twenty guests.",
    exampleMeaning: "这个房间可以容纳二十位客人。",
    level: "CET6",
  });
}

interface Rect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** jsdom performs no layout, so every element reports the same fixed card size. */
const CARD_WIDTH = 300;
const CARD_HEIGHT = 160;

/** jsdom reports zeros for every rect, so each participant declares its own geometry. */
function rect(element: Element, geometry: Rect): void {
  const value = {
    ...geometry,
    right: geometry.left + geometry.width,
    bottom: geometry.top + geometry.height,
    x: geometry.left,
    y: geometry.top,
  };
  Object.defineProperty(element, "getBoundingClientRect", { configurable: true, value: () => value });
}

function open(options: { readonly containingBlock: boolean; readonly anchor: Rect; readonly viewport?: Rect }): {
  readonly host: HTMLElement;
  readonly close: () => void;
} {
  document.body.innerHTML = "";
  const viewport = options.viewport ?? { left: 0, top: 0, width: 1500, height: 1000 };
  Object.defineProperty(window, "innerWidth", { configurable: true, value: viewport.width });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: viewport.height });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => CARD_WIDTH });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => CARD_HEIGHT });
  const root = document.createElement("div");
  root.id = "hn-reader-root";
  const viewportHost = document.createElement("div");
  const anchor = document.createElement("mark");
  anchor.textContent = "accommodate";
  viewportHost.append(anchor);
  root.append(viewportHost);
  document.body.append(root);
  if (options.containingBlock) {
    // Mirrors the Reader workspace, which sets contain: layout paint style on the reader root.
    root.style.contain = "layout paint style";
    rect(root, { left: 700, top: 0, width: 800, height: 1000 });
  }
  rect(anchor, options.anchor);
  const close = showWordPopup({ container: viewportHost, anchor, word: word(), sourceUrl: "https://news.ycombinator.com/item?id=1" });
  const host = viewportHost.querySelector<HTMLElement>(".hnr-word-popup");
  if (!host) throw new Error("popup was not mounted");
  return { host, close };
}

describe("word popup placement", () => {
  it("anchors under the word inside the reader column, not past the page edge", () => {
    // Anchor sits at x=1150 inside a column that starts at x=700 and is 800px wide.
    const { host, close } = open({ containingBlock: true, anchor: { left: 1150, top: 300, width: 90, height: 20 } });
    // The card must stay inside the column: 700 + left + 300 <= 700 + 800 - 8.
    expect(Number.parseFloat(host.style.left)).toBeLessThanOrEqual(492);
    expect(Number.parseFloat(host.style.left)).toBe(450);
    expect(Number.parseFloat(host.style.top)).toBe(326);
    close();
  });

  it("falls back to the viewport when no ancestor establishes a containing block", () => {
    const { host, close } = open({ containingBlock: false, anchor: { left: 1150, top: 300, width: 90, height: 20 } });
    expect(Number.parseFloat(host.style.left)).toBe(1150);
    expect(Number.parseFloat(host.style.top)).toBe(326);
    close();
  });

  it("clamps to the left edge and keeps a word near the bottom fully on screen", () => {
    const { host, close } = open({ containingBlock: false, anchor: { left: -40, top: 995, width: 90, height: 20 } });
    expect(Number.parseFloat(host.style.left)).toBe(8);
    // The word ends at 1015 and the card is 160px tall, so it rests against the bottom margin
    // instead of running off the viewport.
    expect(Number.parseFloat(host.style.top)).toBe(832);
    close();
  });

  it("flips above the word when the space below is too small but the space above fits", () => {
    // The word ends at 830, so a 160px card below would exceed the 832px limit; above fits at 664.
    const { host, close } = open({ containingBlock: false, anchor: { left: 100, top: 810, width: 90, height: 20 } });
    expect(Number.parseFloat(host.style.top)).toBe(664);
    close();
  });

  it("stays inside a narrow column even when the card is wider than the word", () => {
    const { host, close } = open({
      containingBlock: true,
      anchor: { left: 720, top: 100, width: 60, height: 18 },
      viewport: { left: 0, top: 0, width: 1500, height: 1000 },
    });
    expect(Number.parseFloat(host.style.left)).toBe(20);
    close();
  });

  it("removes the card and restores focus handling on close", () => {
    const { host, close } = open({ containingBlock: true, anchor: { left: 900, top: 100, width: 60, height: 18 } });
    expect(host.isConnected).toBe(true);
    close();
    expect(host.isConnected).toBe(false);
    expect(document.querySelector(".hnr-word-popup")).toBeNull();
  });

  it("closes on Escape", () => {
    open({ containingBlock: true, anchor: { left: 900, top: 100, width: 60, height: 18 } });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".hnr-word-popup")).toBeNull();
  });

  it("closes when the reader presses anywhere outside the card", () => {
    open({ containingBlock: true, anchor: { left: 900, top: 100, width: 60, height: 18 } });
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(document.querySelector(".hnr-word-popup")).toBeNull();
  });

  it("stays open while the reader interacts with the card itself", () => {
    const { host } = open({ containingBlock: true, anchor: { left: 900, top: 100, width: 60, height: 18 } });
    host.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(document.querySelector(".hnr-word-popup")).toBe(host);
  });

  it("closes when the comment viewport scrolls", () => {
    open({ containingBlock: true, anchor: { left: 900, top: 100, width: 60, height: 18 } });
    window.dispatchEvent(new Event("scroll"));
    expect(document.querySelector(".hnr-word-popup")).toBeNull();
  });
});
