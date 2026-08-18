import { hashText } from "../kernel/hash";
import type { HttpClient, RequestDescriptor } from "../network/request-contract";
import { assertSafeExternalUrl } from "./url-policy";

export interface FetchedArticle {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly contentType: string;
  readonly html: string;
}

const MAX_ARTICLE_BYTES = 5 * 1024 * 1024;

function contentType(headers: Readonly<Record<string, string>>): string {
  return (headers["content-type"] ?? "text/html").split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export class ArticleFetchAdapter {
  constructor(readonly http: HttpClient) {}

  fetch(rawUrl: string, signal?: AbortSignal): Promise<FetchedArticle> {
    const requested = assertSafeExternalUrl(rawUrl);
    const descriptor: RequestDescriptor<FetchedArticle> = {
      key: `article:fetch:${hashText(requested.href)}`,
      lane: "article",
      method: "GET",
      url: requested.href,
      headers: { Accept: "text/html,application/xhtml+xml,text/plain;q=0.8" },
      timeoutMs: 30_000,
      anonymous: true,
      decode: (response) => {
        const finalUrl = assertSafeExternalUrl(response.finalUrl).href;
        const type = contentType(response.headers);
        if (!new Set(["text/html", "application/xhtml+xml", "text/plain"]).has(type)) {
          throw new Error(`不支持的文章类型：${type || "unknown"}`);
        }
        if (new TextEncoder().encode(response.body).byteLength > MAX_ARTICLE_BYTES) {
          throw new Error("文章响应超过 5 MiB 安全上限");
        }
        return { requestedUrl: requested.href, finalUrl, contentType: type, html: response.body };
      },
    };
    return this.http.request(descriptor, signal);
  }
}
