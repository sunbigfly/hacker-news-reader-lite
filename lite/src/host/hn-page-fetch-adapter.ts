import { RequestError } from "../network/request-contract";
import { RequestScheduler } from "../network/request-scheduler";
import type { StoryId } from "../thread/model";

export interface FetchedHnPage {
  readonly document: Document;
  readonly finalUrl: string;
}

export class HnPageFetchAdapter {
  constructor(
    readonly hostDocument: Document,
    readonly scheduler: RequestScheduler,
    readonly fetchPage?: typeof fetch,
  ) {}

  load(storyId: StoryId, signal?: AbortSignal): Promise<FetchedHnPage> {
    const url = `https://news.ycombinator.com/item?id=${storyId}`;
    return this.scheduler.schedule({
      key: `hn-page:${storyId}`,
      lane: "hn-interactive",
      ...(signal ? { signal } : {}),
      run: async (scheduledSignal) => {
        const pageWindow = this.hostDocument.defaultView;
        const fetchPage = this.fetchPage
          ?? (pageWindow?.fetch ? pageWindow.fetch.bind(pageWindow) : undefined);
        if (!fetchPage) throw new Error("当前浏览器不支持同源评论页请求");
        let response: Response;
        try {
          response = await fetchPage(url, {
            method: "GET",
            credentials: "omit",
            cache: "no-store",
            redirect: "follow",
            headers: { Accept: "text/html,application/xhtml+xml" },
            signal: scheduledSignal,
          });
        } catch (error) {
          if (scheduledSignal.aborted) {
            throw scheduledSignal.reason instanceof Error
              ? scheduledSignal.reason
              : new RequestError("request aborted", "aborted");
          }
          throw new RequestError(
            error instanceof Error ? error.message : "network request failed",
            "network",
          );
        }
        if (!response.ok) {
          throw new RequestError(`HTTP ${response.status}`, "http", response.status);
        }
        const finalUrl = new URL(response.url || url, url);
        if (finalUrl.hostname !== "news.ycombinator.com" || finalUrl.pathname !== "/item") {
          throw new Error("HN 评论页重定向到了非预期地址");
        }
        if (finalUrl.searchParams.get("id") !== String(storyId)) {
          throw new Error("HN 评论页与所选故事不一致");
        }
        const DOMParserConstructor = pageWindow?.DOMParser;
        if (!DOMParserConstructor) throw new Error("当前浏览器不支持 HTML 解析");
        const parsed = new DOMParserConstructor().parseFromString(await response.text(), "text/html");
        const base = parsed.createElement("base");
        base.href = finalUrl.href;
        parsed.head.prepend(base);
        return { document: parsed, finalUrl: finalUrl.href };
      },
    });
  }
}
