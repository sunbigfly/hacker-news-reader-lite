import { RequestError } from "../network/request-contract";
import { RequestScheduler } from "../network/request-scheduler";
import { findHnListTable } from "./hn-list-dom";
import { isHnListPath } from "./hn-route";

export interface FetchedHnListPage {
  readonly document: Document;
  readonly finalUrl: string;
}

function validatedListUrl(rawUrl: string, baseUrl: string): URL {
  const url = new URL(rawUrl, baseUrl);
  if (
    url.protocol !== "https:"
    || url.hostname !== "news.ycombinator.com"
    || url.port
    || url.username
    || url.password
    || !isHnListPath(url.pathname)
  ) {
    throw new Error("HN 列表分页地址不在允许范围内");
  }
  return url;
}

/** Loads signed-in HN list continuations through the page's native same-origin fetch. */
export class HnListPageAdapter {
  constructor(
    readonly hostDocument: Document,
    readonly scheduler: RequestScheduler,
    readonly fetchPage?: typeof fetch,
  ) {}

  load(rawUrl: string, signal?: AbortSignal): Promise<FetchedHnListPage> {
    const url = validatedListUrl(rawUrl, this.hostDocument.baseURI);
    return this.scheduler.schedule({
      key: `hn-list-page:${url.href}`,
      lane: "hn-supplement",
      ...(signal ? { signal } : {}),
      run: async (scheduledSignal) => {
        const pageWindow = this.hostDocument.defaultView;
        const fetchPage = this.fetchPage
          ?? (pageWindow?.fetch ? pageWindow.fetch.bind(pageWindow) : undefined);
        if (!fetchPage) throw new Error("当前浏览器不支持同源分页请求");
        let response: Response;
        try {
          response = await fetchPage(url.href, {
            method: "GET",
            credentials: "same-origin",
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
          throw new RequestError(error instanceof Error ? error.message : "network request failed", "network");
        }
        if (!response.ok) {
          throw new RequestError(`HTTP ${response.status}`, "http", response.status);
        }
        const finalUrl = validatedListUrl(response.url || url.href, url.href);
        if (finalUrl.pathname !== url.pathname) {
          throw new Error("HN 列表分页重定向到了非预期页面");
        }
        const DOMParserConstructor = pageWindow?.DOMParser;
        if (!DOMParserConstructor) throw new Error("当前浏览器不支持 HTML 解析");
        const parsed = new DOMParserConstructor().parseFromString(await response.text(), "text/html");
        const listTable = findHnListTable(parsed);
        if (!listTable?.tBodies[0]) {
          throw new Error("HN 列表分页缺少 itemlist");
        }
        listTable.classList.add("itemlist");
        const base = parsed.createElement("base");
        base.href = finalUrl.href;
        parsed.head.prepend(base);
        return { document: parsed, finalUrl: finalUrl.href };
      },
    });
  }
}
