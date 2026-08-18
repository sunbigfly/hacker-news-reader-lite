// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { buildOfflineHtml, offlineFilename } from "../src/offline/offline-document";
import type { Comment, Story, ThreadSnapshot } from "../src/thread/model";

const story: Story = {
  id: 42 as never,
  title: "Ask HN: offline / reader?",
  url: null,
  author: "author",
  score: 5,
  html: "",
  childIds: [100 as never],
  descendants: 2,
  observedAt: 1,
};

function comment(id: number, parentId: number, html: string): Comment {
  return {
    id: id as never, storyId: 42 as never, parentId: parentId as never,
    childIds: id === 100 ? [101 as never] : [], rank: id, author: `user-${id}`, createdAt: null,
    html, text: `comment ${id}`, deleted: false, dead: false, source: "dom", observedAt: 1,
  };
}

const snapshot: ThreadSnapshot = {
  schemaVersion: 1,
  story,
  comments: [comment(100, 42, "<p>root</p>"), comment(101, 100, "<p>reply</p>")],
  loadedIds: [100 as never, 101 as never],
  missingIds: [],
  complete: true,
  capturedAt: 1,
};

const readerCss = ":host{--hnr-tree:#77a88b}.hnr-comment{color:var(--hnr-ink)}";
const fontSettings = {
  titleFontFamily: "custom",
  titleCustomFontFamily: "Source Han Serif SC",
  fontFamily: "custom",
  customFontFamily: "HarmonyOS Sans SC",
  fontScale: 1.18,
} as const;

describe("offline document", () => {
  it("serializes a self-contained searchable reply tree without credentials", () => {
    const html = buildOfflineHtml({
      snapshot,
      translations: new Map([[100 as never, {
        text: "根评论",
        html: "<p>根评论</p>",
        bilingualHtml: '<p class="hnr-bilingual-original-section">root</p><p class="hnr-bilingual-translation-section">根评论</p>',
      }]]),
      titleTranslation: "询问 HN：离线阅读器？",
      translationMode: "bilingual",
      translationTheme: "paper",
      fontSettings,
      readerCss,
      generatedAt: 2,
    });
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const shadowTemplate = parsed.querySelector<HTMLTemplateElement>('template[shadowrootmode="open"]');
    expect(shadowTemplate?.content.querySelector("#search")).not.toBeNull();
    expect(shadowTemplate?.content.querySelector("#collapse")).not.toBeNull();
    expect(shadowTemplate?.content.querySelector(".hnr-header > .hnr-offline-toolbar")).not.toBeNull();
    expect(shadowTemplate?.content.querySelector("#summary-toggle")).toBeNull();
    expect(shadowTemplate?.content.querySelector("#offline-summary")).toBeNull();
    expect(shadowTemplate?.content.querySelector(".hnr-offline-toolbar.hnr-status")).toBeNull();
    expect(shadowTemplate?.content.querySelector(".hnr-title-subtitle")?.textContent).toBe("询问 HN：离线阅读器？");
    expect(shadowTemplate?.content.querySelector(".hnr-shell.hnr-offline-shell")).not.toBeNull();
    expect(parsed.querySelector("#hn-reader-root")?.getAttribute("data-translation-theme")).toBe("paper");
    expect(shadowTemplate?.content.querySelector(".hnr-meta")).toBeNull();
    expect(shadowTemplate?.content.querySelector(".hnr-header > .hnr-coverage")?.textContent).toContain("2 条评论");
    const originalControl = shadowTemplate?.content.querySelector<HTMLAnchorElement>(".hnr-original-control");
    const originalTooltip = originalControl?.querySelector<HTMLElement>(".hnr-tooltip");
    expect(originalControl?.getAttribute("aria-label")).toBe("回到原帖");
    expect(originalControl?.hasAttribute("title")).toBe(false);
    expect(originalTooltip?.getAttribute("role")).toBe("tooltip");
    expect(originalControl?.getAttribute("aria-describedby")).toBe(originalTooltip?.id);
    expect(new URL(originalControl?.href ?? "").searchParams.get("hnr_native")).toBe("1");
    const embeddedStyle = shadowTemplate?.content.querySelector("style")?.textContent ?? "";
    expect(embeddedStyle).toContain(readerCss);
    expect(embeddedStyle).toContain('--hnr-title-font-family:"Source Han Serif SC",system-ui');
    expect(embeddedStyle).toContain('--hnr-content-font-family:"HarmonyOS Sans SC",system-ui');
    expect(embeddedStyle).toContain("--hnr-font-scale:1.18");
    expect(embeddedStyle).toContain("grid-template-columns: minmax(0, 1fr) auto auto");
    expect(embeddedStyle).toContain("@container hnr-reader (max-width: 1040px)");
    expect(parsed.querySelector("script[src]")).toBeNull();
    expect(parsed.querySelector("link[rel=stylesheet]")).toBeNull();
    const data = JSON.parse(parsed.querySelector("#hnr-data")?.textContent ?? "") as { comments: unknown[] };
    expect(data.comments).toHaveLength(2);
    expect(html).not.toContain("apiKey");
    expect(html).not.toContain("Authorization");
    expect(html).not.toContain("connect-src");
    expect(html).toContain("hnr-comment-actions");
    expect(html).toContain("const attachTooltip=");
    expect(html).not.toContain("element.title=label");
    expect(html).toContain('element.setAttribute("aria-describedby",id)');
    expect(html).toContain("hnr-bilingual-original-section");
    expect(html).toContain("收起此分支");
    expect(html).toContain('rail.className="hnr-tree-rail hnr-tree-collapse-hit"');
    expect(html).toContain('stem.className="hnr-tree-stem hnr-tree-collapse-hit"');
    expect(html).toContain('rail.addEventListener("click",()=>toggleBranch(parent.id))');
    expect(html).toContain('stem.addEventListener("click",()=>toggleBranch(comment.id))');
    expect(html).toContain("row.dataset.hasTranslation");
    expect(html).toContain("row.dataset.collapsed=String(collapsed.has(comment.id))");
    expect(html).toContain("body.hidden=collapsed.has(comment.id)");
    expect(html).toContain('.mode-bilingual .hnr-comment[data-has-translation="true"] .hnr-original-text');
  });

  it("escapes script terminators in serialized user content", () => {
    const hostile = {
      ...snapshot,
      comments: [comment(100, 42, "</script><script>globalThis.pwned=true</script>")],
    };
    const html = buildOfflineHtml({ snapshot: hostile, translations: new Map(), translationMode: "original", translationTheme: "paper", fontSettings, readerCss });
    expect(html).not.toContain("</script><script>globalThis.pwned");
    const parsed = new DOMParser().parseFromString(html, "text/html");
    expect(parsed.querySelectorAll("script")).toHaveLength(2);
  });

  it("embeds the loaded avatar generator once for offline-only data images", () => {
    const previous = (globalThis as typeof globalThis & { readonly multiavatar?: unknown }).multiavatar;
    function multiavatar(seed: string): string {
      return `<svg xmlns="http://www.w3.org/2000/svg"><text>${seed.length}</text></svg>`;
    }
    Reflect.set(globalThis, "multiavatar", multiavatar);
    try {
      const html = buildOfflineHtml({ snapshot, translations: new Map(), translationMode: "original", translationTheme: "paper", fontSettings, readerCss });
      const parsed = new DOMParser().parseFromString(html, "text/html");
      const runtime = parsed.querySelector<HTMLScriptElement>('script[nonce="hnr-offline-v1"]')?.textContent ?? "";

      expect(runtime).toContain("function multiavatar(");
      expect(runtime).toContain("const avatarDataUri=");
      expect(runtime).toContain('avatar.className="hnr-author-avatar"');
      expect(runtime).toContain('"data:image/svg+xml;charset=utf-8,"+encodeURIComponent(svg)');
      expect(html).not.toContain("api.multiavatar.com");
      expect(parsed.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content")).toContain("img-src data:");
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, "multiavatar");
      else Reflect.set(globalThis, "multiavatar", previous);
    }
  });

  it("fully hides a saved summary while keeping its toggle in the frozen header", () => {
    const html = buildOfflineHtml({
      snapshot,
      translations: new Map(),
      translationMode: "original",
      translationTheme: "paper",
      fontSettings,
      readerCss,
      discussionSummary: {
        kind: "discussion",
        overview: "A compact overview",
        consensus: ["Shared point"],
        disputes: ["Open question"],
        branches: [],
        coverageNote: "2 of 2 comments",
        includedComments: 2,
        availableComments: 2,
      },
    });
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const shadowTemplate = parsed.querySelector<HTMLTemplateElement>('template[shadowrootmode="open"]');
    const header = shadowTemplate?.content.querySelector(".hnr-header");
    const toggle = header?.querySelector<HTMLButtonElement>("#summary-toggle");
    const summary = shadowTemplate?.content.querySelector<HTMLElement>("#offline-summary");
    const embeddedStyle = shadowTemplate?.content.querySelector("style")?.textContent ?? "";
    const runtime = parsed.querySelector<HTMLScriptElement>('script[nonce="hnr-offline-v1"]')?.textContent ?? "";

    expect(toggle?.getAttribute("aria-controls")).toBe("offline-summary");
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(toggle?.getAttribute("aria-label")).toBe("收起摘要");
    expect(toggle?.hasAttribute("title")).toBe(false);
    expect(toggle?.getAttribute("aria-describedby")).toBe(toggle?.querySelector(".hnr-tooltip")?.id);
    expect(summary?.hasAttribute("hidden")).toBe(false);
    expect(summary?.getAttribute("aria-labelledby")).toBe("hnr-offline-summary-title");
    expect(embeddedStyle).toContain('.hnr-offline-shell .hnr-summary[hidden] { display: none; }');
    expect(embeddedStyle).toContain(".hnr-offline-shell > .hnr-comments { grid-row: 3; }");
    expect(runtime).toContain("summaryPanel.hidden=!expanded");
    expect(runtime).toContain('summaryToggle.setAttribute("aria-expanded",String(expanded))');
    expect(runtime).toContain('const label=expanded?"收起摘要":"展开摘要"');
    expect(runtime).toContain("setSummaryExpanded(true);summaryPanel.scrollTop=0");
  });

  it("creates a portable filename", () => {
    expect(offlineFilename({ snapshot, translations: new Map(), translationMode: "original", translationTheme: "paper", fontSettings, readerCss }))
      .toBe("Ask HN offline reader-hn-42.html");
  });
});
