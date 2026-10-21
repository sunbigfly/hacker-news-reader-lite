// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { VocabularyWord } from "../src/vocabulary/model";
import { bindWordCard, showWordPopup, WORD_CARD_CLOSE_DELAY_MS, WORD_CARD_OPEN_DELAY_MS } from "../src/vocabulary/word-popup";

describe("word card hover", () => {
  it("waits for a deliberate dwell before showing anything", () => {
    vi.useFakeTimers();
    try {
      const anchor = document.createElement("span");
      document.body.append(anchor);
      let open = false;
      bindWordCard(anchor, () => {
        open = true;
        return () => { open = false; };
      });

      anchor.dispatchEvent(new PointerEvent("pointerenter"));
      expect(open).toBe(false);
      vi.advanceTimersByTime(WORD_CARD_OPEN_DELAY_MS - 1);
      expect(open).toBe(false);
      vi.advanceTimersByTime(1);
      expect(open).toBe(true);
      anchor.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens nothing when the pointer only passes through", () => {
    vi.useFakeTimers();
    try {
      const anchor = document.createElement("span");
      document.body.append(anchor);
      let open = false;
      bindWordCard(anchor, () => {
        open = true;
        return () => { open = false; };
      });

      anchor.dispatchEvent(new PointerEvent("pointerenter"));
      vi.advanceTimersByTime(WORD_CARD_OPEN_DELAY_MS - 1);
      anchor.dispatchEvent(new PointerEvent("pointerleave"));
      vi.advanceTimersByTime(WORD_CARD_OPEN_DELAY_MS);
      expect(open).toBe(false);
      anchor.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not open a card for a word removed during the hover delay", () => {
    vi.useFakeTimers();
    try {
      const anchor = document.createElement("mark");
      document.body.append(anchor);
      const open = vi.fn(() => () => {});
      bindWordCard(anchor, open);
      anchor.dispatchEvent(new PointerEvent("pointerenter"));
      anchor.remove();
      vi.advanceTimersByTime(WORD_CARD_OPEN_DELAY_MS);
      expect(open).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("disposes the pending hover and the open card when its word is recycled", () => {
    vi.useFakeTimers();
    try {
      const anchor = document.createElement("mark");
      document.body.append(anchor);
      const close = vi.fn();
      const open = vi.fn(() => close);
      const dispose = bindWordCard(anchor, open);
      anchor.dispatchEvent(new FocusEvent("focus"));
      expect(open).toHaveBeenCalledTimes(1);
      dispose();
      expect(close).toHaveBeenCalledTimes(1);
      anchor.dispatchEvent(new PointerEvent("pointerenter"));
      vi.advanceTimersByTime(WORD_CARD_OPEN_DELAY_MS);
      expect(open).toHaveBeenCalledTimes(1);
      anchor.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the card while the pointer travels into it, and closes once it leaves both", () => {
    vi.useFakeTimers();
    try {
      const anchor = document.createElement("span");
      document.body.append(anchor);
      let hooks: { readonly onPointerEnter: () => void; readonly onPointerLeave: () => void } | undefined;
      let open = false;
      bindWordCard(anchor, (binding) => {
        hooks = binding;
        open = true;
        return () => { open = false; };
      });
      anchor.dispatchEvent(new PointerEvent("pointerenter"));
      vi.advanceTimersByTime(WORD_CARD_OPEN_DELAY_MS);
      expect(open).toBe(true);

      // The pointer leaves the word and arrives on the card within the grace period.
      anchor.dispatchEvent(new PointerEvent("pointerleave"));
      vi.advanceTimersByTime(WORD_CARD_CLOSE_DELAY_MS - 60);
      hooks?.onPointerEnter();
      vi.advanceTimersByTime(WORD_CARD_CLOSE_DELAY_MS);
      expect(open).toBe(true);

      hooks?.onPointerLeave();
      vi.advanceTimersByTime(WORD_CARD_CLOSE_DELAY_MS);
      expect(open).toBe(false);
      anchor.remove();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens at once for the keyboard, which has no pointer to dwell with", () => {
    const anchor = document.createElement("span");
    document.body.append(anchor);
    let open = false;
    bindWordCard(anchor, () => {
      open = true;
      return () => { open = false; };
    });
    anchor.dispatchEvent(new FocusEvent("focus"));
    expect(open).toBe(true);
    anchor.dispatchEvent(new FocusEvent("blur"));
    expect(open).toBe(false);
    anchor.remove();
  });

  it("pins a touch card, consumes an enclosing link click, and can reopen after self-dismissal", () => {
    vi.useFakeTimers();
    try {
      const link = document.createElement("a");
      link.href = "https://example.com/article";
      const anchor = document.createElement("mark");
      link.append(anchor);
      document.body.append(link);
      const followed = vi.fn();
      link.addEventListener("click", followed);
      let hooks: { readonly onDismiss: () => void } | undefined;
      let open = false;
      let opened = 0;
      bindWordCard(anchor, (binding) => {
        hooks = binding;
        open = true;
        opened += 1;
        return () => { open = false; };
      });

      anchor.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "touch" }));
      vi.advanceTimersByTime(WORD_CARD_OPEN_DELAY_MS);
      expect(open).toBe(false);

      anchor.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true }));
      anchor.dispatchEvent(new FocusEvent("focus"));
      const click = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
      anchor.dispatchEvent(click);
      expect(open).toBe(true);
      expect(click.defaultPrevented).toBe(true);
      expect(followed).not.toHaveBeenCalled();

      anchor.dispatchEvent(new PointerEvent("pointerleave", { pointerType: "touch" }));
      vi.advanceTimersByTime(WORD_CARD_CLOSE_DELAY_MS);
      expect(open).toBe(true);

      open = false;
      hooks?.onDismiss();
      anchor.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "touch" }));
      anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
      expect(open).toBe(true);
      expect(opened).toBe(2);
      link.remove();
    } finally {
      vi.useRealTimers();
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
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

function open(options: {
  readonly containingBlock: boolean;
  readonly shadow?: boolean;
  readonly anchor: Rect;
  readonly viewport?: Rect;
  readonly onPointerEnter?: () => void;
  readonly onPointerLeave?: () => void;
}): {
  readonly host: HTMLElement;
  readonly anchor: HTMLElement;
  readonly container: HTMLElement;
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
  if (options.shadow) root.attachShadow({ mode: "open" }).append(viewportHost);
  else root.append(viewportHost);
  document.body.append(root);
  if (options.containingBlock) {
    // Mirrors the Reader workspace, which sets contain: layout paint style on the reader root.
    root.style.contain = "layout paint style";
    rect(root, { left: 700, top: 0, width: 800, height: 1000 });
  }
  rect(anchor, options.anchor);
  const close = showWordPopup({
    container: viewportHost,
    anchor,
    word: word(),
    sourceUrl: "https://news.ycombinator.com/item?id=1",
    ...(options.onPointerEnter ? { onPointerEnter: options.onPointerEnter } : {}),
    ...(options.onPointerLeave ? { onPointerLeave: options.onPointerLeave } : {}),
  });
  const host = viewportHost.querySelector<HTMLElement>(".hnr-word-popup");
  if (!host) throw new Error("popup was not mounted");
  return { host, anchor, container: viewportHost, close };
}

describe("word popup placement", () => {
  it("uses the containing block across the Reader shadow root", () => {
    const { host, close } = open({ containingBlock: true, shadow: true, anchor: { left: 900, top: 300, width: 90, height: 20 } });
    expect(Number.parseFloat(host.style.left)).toBe(200);
    expect(Number.parseFloat(host.style.top)).toBe(326);
    close();
  });

  it("uses the nearest transformed containing block instead of a positioned outer wrapper", () => {
    const { host, anchor, container, close } = open({ containingBlock: true, anchor: { left: 1000, top: 200, width: 90, height: 20 } });
    close();
    container.style.transform = "translateX(0)";
    rect(container, { left: 800, top: 40, width: 600, height: 900 });
    const dispose = showWordPopup({ container, anchor, word: word(), sourceUrl: "https://news.ycombinator.com/item?id=1" });
    const next = container.querySelector<HTMLElement>(".hnr-word-popup");
    expect(next).not.toBe(host);
    expect(Number.parseFloat(next?.style.left ?? "")).toBe(200);
    expect(Number.parseFloat(next?.style.top ?? "")).toBe(186);
    dispose();
  });

  it("dismisses a stale anchor during a resize instead of moving the card to the origin", () => {
    let resized: ResizeObserverCallback | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resized = callback; }
      observe(): void {}
      disconnect = disconnect;
    });
    const { host, anchor, close } = open({ containingBlock: true, anchor: { left: 900, top: 300, width: 90, height: 20 } });
    const left = host.style.left;
    anchor.remove();
    rect(anchor, { left: 0, top: 0, width: 0, height: 0 });
    resized?.([], {} as ResizeObserver);
    expect(host.isConnected).toBe(false);
    expect(host.style.left).toBe(left);
    expect(disconnect).toHaveBeenCalled();
    close();
  });

  it("keeps only the current word card in one Reader viewport", () => {
    const { host, anchor, container } = open({ containingBlock: false, anchor: { left: 100, top: 300, width: 90, height: 20 } });
    const close = showWordPopup({ container, anchor, word: word(), sourceUrl: "https://news.ycombinator.com/item?id=1" });
    expect(host.isConnected).toBe(false);
    expect(container.querySelectorAll(".hnr-word-popup")).toHaveLength(1);
    close();
  });

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
    // Nothing fits below the word, so the card sits above it and still ends inside the viewport.
    expect(Number.parseFloat(host.style.top)).toBe(829);
    close();
  });

  it("flips above the word when the space below is too small but the space above fits", () => {
    // The word spans 810-830, so a 160px card below would exceed the 832px limit; above puts the card's
    // bottom 6px clear of the word's top.
    const { host, close } = open({ containingBlock: false, anchor: { left: 100, top: 810, width: 90, height: 20 } });
    expect(Number.parseFloat(host.style.top)).toBe(644);
    close();
  });

  it("never covers its own word, which is what made the pair flicker", () => {
    // With no room below and not enough above for the natural height, the roomier side is used with the
    // card capped to it: a card painted over its own word loses hover the moment it appears.
    for (const top of [600, 810, 900, 995]) {
      const { host, close } = open({ containingBlock: false, anchor: { left: 100, top, width: 90, height: 20 } });
      const cardTop = Number.parseFloat(host.style.top);
      const cardHeight = Math.min(CARD_HEIGHT, Number.parseFloat(host.style.getPropertyValue("--hnr-popup-max-height")));
      const cardBottom = cardTop + cardHeight;
      expect(cardBottom <= top || cardTop >= top + 20, `anchor ${top}`).toBe(true);
      close();
    }
  });

  it("caps the card to the space it was given so a long entry scrolls instead of overflowing", () => {
    // A short bracket with the word in the middle: neither side has room for the natural card, so the
    // roomier side wins and the card is capped to it — clear of the word either way.
    const { host, close } = open({
      containingBlock: false,
      anchor: { left: 100, top: 150, width: 90, height: 20 },
      viewport: { left: 0, top: 0, width: 1500, height: 300 },
    });
    expect(Number.parseFloat(host.style.top)).toBe(8);
    expect(Number.parseFloat(host.style.getPropertyValue("--hnr-popup-max-height"))).toBe(136);
    close();
  });

  it("leaves the card uncapped when a side has room for all of it", () => {
    const { host, close } = open({ containingBlock: false, anchor: { left: 100, top: 100, width: 90, height: 20 } });
    expect(Number.parseFloat(host.style.top)).toBe(126);
    expect(Number.parseFloat(host.style.getPropertyValue("--hnr-popup-max-height"))).toBeGreaterThanOrEqual(CARD_HEIGHT);
    close();
  });

  it("keeps the card alive while the pointer travels from the word into it", () => {
    vi.useFakeTimers();
    try {
      const entered: number[] = [];
      const left: number[] = [];
      const { host, close } = open({
        containingBlock: false,
        anchor: { left: 100, top: 300, width: 90, height: 20 },
        onPointerEnter: () => entered.push(1),
        onPointerLeave: () => left.push(1),
      });
      host.dispatchEvent(new PointerEvent("pointerenter"));
      host.dispatchEvent(new PointerEvent("pointerleave"));
      expect(entered).toHaveLength(1);
      expect(left).toHaveLength(1);
      close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a scroll that happens inside the capped card", () => {
    const { host } = open({ containingBlock: false, anchor: { left: 100, top: 840, width: 90, height: 20 } });
    host.dispatchEvent(new Event("scroll"));
    expect(document.querySelector(".hnr-word-popup")).toBe(host);
  });

  it("reacts to a scroll by repositioning rather than by reading the capped height", () => {
    // The card is read once, so a resize observation cannot flip it between the two sides of the word.
    const { host } = open({ containingBlock: false, anchor: { left: 100, top: 900, width: 90, height: 20 } });
    const top = host.style.top;
    const capped = host.style.getPropertyValue("--hnr-popup-max-height");
    window.dispatchEvent(new Event("resize"));
    expect(host.style.top).toBe(top);
    expect(host.style.getPropertyValue("--hnr-popup-max-height")).toBe(capped);
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
    const { host, container } = open({ containingBlock: true, shadow: true, anchor: { left: 900, top: 100, width: 60, height: 18 } });
    const outsideScroll = vi.fn();
    window.addEventListener("scroll", outsideScroll, true);
    try {
      container.dispatchEvent(new Event("scroll", { bubbles: false, composed: false }));
      expect(outsideScroll).not.toHaveBeenCalled();
      expect(host.isConnected).toBe(false);
    } finally {
      window.removeEventListener("scroll", outsideScroll, true);
    }
  });
});
