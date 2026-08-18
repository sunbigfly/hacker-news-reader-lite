import { describe, expect, it } from "vitest";
import { ArticleFetchAdapter } from "../src/article/article-fetch-adapter";
import type { HttpClient, RequestDescriptor } from "../src/network/request-contract";

class FetchHttp implements HttpClient {
  constructor(
    readonly finalUrl = "https://example.com/final",
    readonly type = "text/html; charset=utf-8",
    readonly body = "<article>body</article>",
  ) {}

  request<T>(descriptor: RequestDescriptor<T>): Promise<T> {
    expect(descriptor.anonymous).toBe(true);
    expect(descriptor.headers).not.toHaveProperty("Cookie");
    return Promise.resolve().then(() => descriptor.decode({
      status: 200,
      statusText: "OK",
      headers: { "content-type": this.type },
      body: this.body,
      finalUrl: this.finalUrl,
    }));
  }
}

describe("ArticleFetchAdapter", () => {
  it("fetches public HTML anonymously and records a safe final URL", async () => {
    const result = await new ArticleFetchAdapter(new FetchHttp()).fetch("https://example.com/start#fragment");
    expect(result.requestedUrl).toBe("https://example.com/start");
    expect(result.finalUrl).toBe("https://example.com/final");
  });

  it("revalidates redirects and response types", async () => {
    await expect(new ArticleFetchAdapter(new FetchHttp("http://127.0.0.1/admin")).fetch("https://example.com"))
      .rejects.toThrow(/本机|私有|保留/);
    await expect(new ArticleFetchAdapter(new FetchHttp("https://example.com/file.pdf", "application/pdf")).fetch("https://example.com"))
      .rejects.toThrow(/不支持的文章类型/);
  });

  it("rejects responses larger than five MiB", async () => {
    const body = "a".repeat(5 * 1024 * 1024 + 1);
    await expect(new ArticleFetchAdapter(new FetchHttp("https://example.com/large", "text/plain", body)).fetch("https://example.com"))
      .rejects.toThrow(/5 MiB/);
  });
});
