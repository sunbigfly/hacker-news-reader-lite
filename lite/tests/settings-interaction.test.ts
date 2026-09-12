// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseHnDocument } from "../src/host/hn-dom-adapter";
import { LifecycleScope } from "../src/kernel/lifecycle";
import { DEFAULT_SETTINGS } from "../src/settings/settings-store";
import { ReaderView } from "../src/shell/reader-view";
import { CommentProjection } from "../src/thread/comment-projection";
import { CommentTree } from "../src/thread/comment-tree";

afterEach(() => { vi.useRealTimers(); });

it("keeps settings input focused and buffers background comment rendering until dismissal", async () => {
  vi.useFakeTimers();
  document.documentElement.innerHTML = readFileSync(resolve("lite/fixtures/hn-item.html"), "utf8");
  const snapshot = parseHnDocument(document);
  const scope = new LifecycleScope();
  const tree = new CommentTree(snapshot.story, snapshot.comments);
  const projection = new CommentProjection(tree);
  const onSettingsPreview = vi.fn();
  const view = new ReaderView(document, tree, projection, true, {
    onClose: vi.fn(), onCommand: vi.fn(), onCommentAction: vi.fn(),
    onViewportCommentsChanged: vi.fn(), onToggleComment: vi.fn(), onLoadMissing: vi.fn(),
  }, scope, "", document.body);
  try {
    await Promise.resolve();
    const id = snapshot.comments[0]?.id;
    if (!id) throw new Error("Fixture has no comments");
    view.locateComment(id, true);
    vi.advanceTimersByTime(40);
    view.openSettings(DEFAULT_SETTINGS, {
      onSave: vi.fn(), onLoadModels: vi.fn().mockResolvedValue([]),
      onClearCache: vi.fn().mockResolvedValue(undefined), onReset: vi.fn(), onSettingsPreview,
    });
    await Promise.resolve();
    const input = view.surfaceRoot.querySelector<HTMLInputElement>('input[name="replyCollapseThreshold"]');
    if (!input) throw new Error("Settings input was not rendered");
    const row = view.surfaceRoot.querySelector(`.hnr-comment[data-comment-id="${id}"]`);
    input.focus();
    input.value = "12";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    view.applyPreheat(new Map());
    view.update(tree, projection, true);
    vi.advanceTimersByTime(48);
    expect(view.surfaceRoot.activeElement).toBe(input);
    expect(view.surfaceRoot.querySelector(`.hnr-comment[data-comment-id="${id}"]`)).toBe(row);
    expect(input.value).toBe("12");
    expect(onSettingsPreview).not.toHaveBeenCalled();
    const cancel = view.surfaceRoot.querySelector<HTMLButtonElement>(".hnr-settings-cancel");
    if (!cancel) throw new Error("Settings cancel button was not rendered");
    cancel.click();
    expect(view.surfaceRoot.querySelector(".hnr-settings-backdrop")).toBeNull();
    expect(view.surfaceRoot.querySelector(`.hnr-comment[data-comment-id="${id}"]`)).not.toBe(row);
  } finally { scope.destroy(); }
});
