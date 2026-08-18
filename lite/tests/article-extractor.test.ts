// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { ArticleExtractor } from "../src/article/article-extractor";

const paragraph = "This is substantial article prose with enough words to explain a technical idea clearly to an attentive reader. ";
const cases: readonly [string, string, "good" | "degraded" | "reject"][] = [
  ["semantic article", `<article><h1>A</h1><p>${paragraph.repeat(3)}</p><p>${paragraph}</p><p>${paragraph}</p></article>`, "good"],
  ["main", `<main><h1>A</h1><p>${paragraph.repeat(6)}</p></main>`, "good"],
  ["role main", `<div role="main"><p>${paragraph.repeat(6)}</p></div>`, "good"],
  ["itemprop", `<div itemprop="articleBody"><p>${paragraph.repeat(6)}</p></div>`, "good"],
  ["blog class", `<div class="post-content"><p>${paragraph.repeat(6)}</p></div>`, "good"],
  ["documentation code", `<main><h1>Docs</h1><p>${paragraph.repeat(3)}</p><pre>npm install package</pre><p>${paragraph.repeat(2)}</p></main>`, "good"],
  ["table", `<article><p>${paragraph.repeat(4)}</p><table><tr><th>A</th><td>B</td></tr></table></article>`, "degraded"],
  ["short body fallback", `<body><div>${paragraph.repeat(2)}</div></body>`, "degraded"],
  ["login wall", `<main><p>Sign in to continue reading this protected article.</p></main>`, "reject"],
  ["paywall", `<article><p>Subscribe to continue reading this story and unlock access.</p></article>`, "reject"],
  ["js only", `<main><p>Enable JavaScript to continue.</p></main>`, "reject"],
  ["empty", `<main></main>`, "reject"],
  ["nav heavy", `<nav>${paragraph.repeat(5)}</nav><article><p>${paragraph.repeat(6)}</p></article>`, "good"],
  ["malicious", `<article><p>${paragraph.repeat(6)}</p><script>alert(1)</script><img src="javascript:alert(1)"></article>`, "good"],
  ["relative link", `<article><p>${paragraph.repeat(6)}</p><a href="/guide">Guide</a></article>`, "good"],
];

describe("ArticleExtractor 15-structure classification", () => {
  it.each(cases)("classifies %s", (_name, html, expected) => {
    const extractor = new ArticleExtractor();
    const action = () => extractor.extract({ requestedUrl: "https://example.com/post", finalUrl: "https://example.com/post", contentType: "text/html", html }, document, 1);
    if (expected === "reject") expect(action).toThrow();
    else {
      const result = action();
      expect(result.quality).toBe(expected);
      expect(result.html).not.toContain("<script");
      expect(result.html).not.toContain("javascript:");
      if (_name === "relative link") expect(result.html).toContain("https://example.com/guide");
    }
  });
});
