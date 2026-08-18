import { RequestError } from "../network/request-contract";
import { RequestScheduler } from "../network/request-scheduler";

export interface FetchedHnHostPage {
  readonly document: Document;
  readonly finalUrl: string;
}

function validatedHostUrl(rawUrl: string, baseUrl: string): URL {
  const url = new URL(rawUrl, baseUrl);
  if (
    url.protocol !== "https:"
    || url.hostname !== "news.ycombinator.com"
    || url.port
    || url.username
    || url.password
  ) {
    throw new Error("HN 宿主地址不在允许范围内");
  }
  return url;
}

/** Loads a read-only HN page for transactional replacement inside the host pane. */
export class HnHostPageAdapter {
  constructor(
    readonly hostDocument: Document,
    readonly scheduler: RequestScheduler,
    readonly fetchPage?: typeof fetch,
  ) {}

  load(rawUrl: string, signal?: AbortSignal): Promise<FetchedHnHostPage> {
    const url = validatedHostUrl(rawUrl, this.hostDocument.baseURI);
    const requestedHash = url.hash;
    url.hash = "";
    return this.scheduler.schedule({
      key: `hn-host-page:${url.href}${requestedHash}`,
      lane: "hn-interactive",
      ...(signal ? { signal } : {}),
      run: async (scheduledSignal) => {
        const pageWindow = this.hostDocument.defaultView;
        const fetchPage = this.fetchPage
          ?? (pageWindow?.fetch ? pageWindow.fetch.bind(pageWindow) : undefined);
        if (!fetchPage) throw new Error("当前浏览器不支持同源宿主请求");
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
          throw new RequestError(
            error instanceof Error ? error.message : "network request failed",
            "network",
          );
        }
        if (!response.ok) {
          throw new RequestError(`HTTP ${response.status}`, "http", response.status);
        }
        const finalUrl = validatedHostUrl(response.url || url.href, url.href);
        finalUrl.hash = requestedHash;
        const DOMParserConstructor = pageWindow?.DOMParser;
        if (!DOMParserConstructor) throw new Error("当前浏览器不支持 HTML 解析");
        const parsed = new DOMParserConstructor().parseFromString(
          await response.text(),
          "text/html",
        );
        const hasStandardShell = parsed.querySelector("#hnmain > tbody") !== null;
        const hasStandaloneContent = [...parsed.body.childNodes].some((node) => (
          node.nodeType === 1
          || (node.nodeType === 3 && Boolean(node.textContent?.trim()))
        ));
        if (!hasStandardShell && !hasStandaloneContent) {
          throw new Error("HN 宿主页缺少可呈现内容");
        }
        const base = parsed.createElement("base");
        base.href = finalUrl.href;
        parsed.head.prepend(base);
        return { document: parsed, finalUrl: finalUrl.href };
      },
    });
  }
}
