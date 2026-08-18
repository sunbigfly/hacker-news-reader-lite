import { sanitizeHtml, textFromHtml } from "../security/sanitize-html";
import type { FetchedArticle } from "./article-fetch-adapter";
import { assertSafeExternalUrl } from "./url-policy";

export interface ArticleSnapshot {
  readonly sourceUrl: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly byline: string | null;
  readonly siteName: string;
  readonly html: string;
  readonly text: string;
  readonly wordCount: number;
  readonly quality: "good" | "degraded";
  readonly extractedAt: number;
}

const CANDIDATE_SELECTORS = [
  "article", "main", "[role='main']", "[itemprop='articleBody']",
  "#content", ".article-body", ".article-content", ".post-content", ".entry-content", ".markdown-body",
];
const REMOVE_SELECTORS = [
  "script", "style", "noscript", "form", "iframe", "object", "embed", "nav", "aside",
  "[hidden]", "[aria-hidden='true']", ".advertisement", ".ads", ".related", ".recommendations",
  ".newsletter", ".social-share", ".comments", ".cookie", ".modal",
];

function normalizedText(element: Element | null): string {
  return (element?.textContent ?? "").replace(/\s+/g, " ").trim();
}

function candidateScore(element: Element): number {
  const text = normalizedText(element);
  const linkText = [...element.querySelectorAll("a")].reduce((sum, link) => sum + normalizedText(link).length, 0);
  const paragraphs = element.querySelectorAll("p").length;
  const semantic = element.matches("article,[itemprop='articleBody']") ? 500 : element.matches("main,[role='main']") ? 300 : 0;
  const rich = element.querySelectorAll("pre,blockquote,table,ul,ol,h1,h2,h3").length * 35;
  const linkPenalty = text.length > 0 ? Math.round((linkText / text.length) * 1_000) : 1_000;
  return text.length + paragraphs * 90 + semantic + rich - linkPenalty;
}

function metaContent(document: Document, selectors: readonly string[]): string | null {
  for (const selector of selectors) {
    const value = document.querySelector<HTMLMetaElement>(selector)?.content?.trim();
    if (value) return value;
  }
  return null;
}

export class ArticleExtractor {
  extract(fetched: FetchedArticle, hostDocument: Document, extractedAt = Date.now()): ArticleSnapshot {
    const Parser = hostDocument.defaultView?.DOMParser ?? DOMParser;
    const parsed = new Parser().parseFromString(fetched.html, "text/html");
    for (const node of parsed.querySelectorAll(REMOVE_SELECTORS.join(","))) node.remove();
    const candidates = [...new Set(CANDIDATE_SELECTORS.flatMap((selector) => [...parsed.querySelectorAll(selector)]))];
    if (parsed.body) candidates.push(parsed.body);
    const best = candidates.sort((left, right) => candidateScore(right) - candidateScore(left))[0] ?? null;
    const rawText = normalizedText(best);
    const protectedSignal = /(?:sign in|log in|subscribe to continue|enable javascript|paywall)/i.test(rawText);
    if (!best || rawText.length < 80 || (protectedSignal && rawText.length < 500)) {
      throw new Error(protectedSignal ? "文章受登录墙、付费墙或脚本限制" : "页面没有足够的可提取正文");
    }
    const title = metaContent(parsed, ["meta[property='og:title']", "meta[name='twitter:title']"])
      || normalizedText(best.querySelector("h1"))
      || parsed.title.trim()
      || new URL(fetched.finalUrl).hostname;
    const byline = metaContent(parsed, ["meta[name='author']", "meta[property='article:author']"])
      || normalizedText(parsed.querySelector("[rel='author'],.byline,.author"))
      || null;
    const canonicalRaw = parsed.querySelector<HTMLLinkElement>("link[rel='canonical']")?.href || fetched.finalUrl;
    let canonicalUrl = fetched.finalUrl;
    try { canonicalUrl = assertSafeExternalUrl(new URL(canonicalRaw, fetched.finalUrl).href).href; } catch { /* retain final URL */ }
    const clone = best.cloneNode(true) as Element;
    for (const node of clone.querySelectorAll(REMOVE_SELECTORS.join(","))) node.remove();
    const html = sanitizeHtml(clone.innerHTML, hostDocument, fetched.finalUrl);
    const text = textFromHtml(html, hostDocument);
    if (text.length < 80) throw new Error("清洗后没有足够的可读正文");
    const paragraphs = clone.querySelectorAll("p").length;
    return {
      sourceUrl: fetched.requestedUrl,
      canonicalUrl,
      title: title.slice(0, 300),
      byline: byline?.slice(0, 200) ?? null,
      siteName: new URL(fetched.finalUrl).hostname.replace(/^www\./, ""),
      html,
      text,
      wordCount: text.split(/\s+/).filter(Boolean).length,
      quality: text.length >= 500 || paragraphs >= 3 ? "good" : "degraded",
      extractedAt,
    };
  }
}
