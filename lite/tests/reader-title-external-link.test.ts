// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseHnDocument } from "../src/host/hn-dom-adapter";
import { LifecycleScope } from "../src/kernel/lifecycle";
import { ReaderView } from "../src/shell/reader-view";
import { CommentProjection } from "../src/thread/comment-projection";
import { CommentTree } from "../src/thread/comment-tree";

function createView(storyUrl: string | null): { readonly scope: LifecycleScope; readonly view: ReaderView } {
  document.documentElement.innerHTML = readFileSync(resolve("lite/fixtures/hn-item.html"), "utf8");
  const snapshot = parseHnDocument(document);
  const tree = new CommentTree({ ...snapshot.story, url: storyUrl }, snapshot.comments);
  const scope = new LifecycleScope();
  const view = new ReaderView(document, tree, new CommentProjection(tree), true, {
    onClose: vi.fn(),
    onCommand: vi.fn(),
    onCommentAction: vi.fn(),
    onViewportCommentsChanged: vi.fn(),
    onToggleComment: vi.fn(),
    onLoadMissing: vi.fn(),
  }, scope, "", document.body);
  return { scope, view };
}

describe("Reader title external link", () => {
  it("keeps ordinary title clicks local and leaves Ctrl/Cmd clicks native", () => {
    const { scope, view } = createView("https://example.com/article");
    const title = view.surfaceRoot.querySelector<HTMLAnchorElement>(".hnr-title-jump");
    if (!title) throw new Error("Reader title link was not rendered");

    expect(title.href).toBe("https://example.com/article");
    expect(title.target).toBe("_blank");
    expect(title.rel).toBe("noopener noreferrer");

    const ordinaryClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    title.dispatchEvent(ordinaryClick);
    expect(ordinaryClick.defaultPrevented).toBe(true);

    const ctrlClick = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    title.dispatchEvent(ctrlClick);
    expect(ctrlClick.defaultPrevented).toBe(false);

    const metaClick = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
    title.dispatchEvent(metaClick);
    expect(metaClick.defaultPrevented).toBe(false);
    scope.destroy();
  });

  it("keeps titles without a safe external URL on the local scroll target", () => {
    const { scope, view } = createView(null);
    const title = view.surfaceRoot.querySelector<HTMLAnchorElement>(".hnr-title-jump");
    if (!title) throw new Error("Reader title link was not rendered");

    expect(title.getAttribute("href")).toBe("#hnr-reader-comments");
    expect(title.hasAttribute("target")).toBe(false);
    const ctrlClick = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
    title.dispatchEvent(ctrlClick);
    expect(ctrlClick.defaultPrevented).toBe(true);
    scope.destroy();
  });
});
