import {
  RequestError,
  type HttpClient,
  type HttpResponse,
  type RequestDescriptor,
} from "./request-contract";
import { RequestScheduler } from "./request-scheduler";

function parseHeaders(rawHeaders = ""): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const line of rawHeaders.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name) headers[name] = value;
  }
  return Object.freeze(headers);
}

function responseTarget(response: GmRequestResponse | GmRequestProgress): GmRequestProgress["target"] {
  return "target" in response ? response.target : undefined;
}

function responseText(response: GmRequestResponse | GmRequestProgress): string {
  const target = responseTarget(response);
  const candidates = [response.responseText, response.response, target?.responseText, target?.response];
  return candidates.find((value): value is string => typeof value === "string") ?? "";
}

function responseStream(response: GmRequestResponse | GmRequestProgress): ReadableStream<Uint8Array> | null {
  const target = responseTarget(response);
  const candidates = [response.response, target?.response];
  return candidates.find((value): value is ReadableStream<Uint8Array> =>
    Boolean(value && typeof (value as { getReader?: unknown }).getReader === "function")) ?? null;
}

function normalizeResponse(
  response: GmRequestResponse | GmRequestProgress,
  fallbackUrl: string,
  body = responseText(response),
): HttpResponse {
  const target = responseTarget(response);
  return Object.freeze({
    status: response.status ?? target?.status ?? 0,
    statusText: response.statusText ?? target?.statusText ?? "",
    headers: parseHeaders(response.responseHeaders ?? target?.responseHeaders),
    body,
    finalUrl: response.finalUrl ?? target?.responseURL ?? fallbackUrl,
  });
}

function completedStreamResponse(response: HttpResponse): HttpResponse {
  if (response.status !== 0) return response;
  return Object.freeze({
    ...response,
    status: 200,
    statusText: response.statusText || "OK",
  });
}

function localPhase(descriptor: RequestDescriptor<unknown>, phase: string, bytes = 0): void {
  if (
    typeof __HN_READER_BUILD__ === "undefined"
    || __HN_READER_BUILD__ !== "local"
    || typeof document === "undefined"
  ) return;
  document.dispatchEvent(new CustomEvent("hnr:request-phase", { detail: Object.freeze({
    key: descriptor.key,
    phase,
    bytes,
    at: performance.now(),
  }) }));
}

/** Stable userscript HTTP port adapted from the referenced GM-only boundary and extended per request. */
// local-loader-cache-bust: keep the installed debug resource aligned with source.
export class GmHttpClient implements HttpClient {
  constructor(readonly scheduler: RequestScheduler | null = null) {}

  request<T>(descriptor: RequestDescriptor<T>, signal?: AbortSignal): Promise<T> {
    const run = (requestSignal: AbortSignal): Promise<T> => this.#execute(descriptor, requestSignal);
    if (!this.scheduler) {
      const controller = new AbortController();
      const abort = (): void => controller.abort(signal?.reason);
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      return run(controller.signal).finally(() => signal?.removeEventListener("abort", abort));
    }
    return this.scheduler.schedule({
      key: descriptor.key,
      lane: descriptor.lane,
      ...(signal ? { signal } : {}),
      run,
    });
  }

  #execute<T>(descriptor: RequestDescriptor<T>, signal: AbortSignal, redirectDepth = 0): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let streamStarted = false;
      let handle: GmRequestHandle | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        if (timer !== null) clearTimeout(timer);
        timer = null;
        callback();
      };
      const fail = (error: RequestError): void => finish(() => reject(error));
      const onAbort = (): void => {
        const reason = signal.reason instanceof Error
          ? signal.reason
          : new RequestError("request aborted", "aborted");
        finish(() => reject(reason));
        handle?.abort();
      };
      const onTimeout = (): void => {
        fail(new RequestError("network request timed out", "timeout"));
        handle?.abort();
      };
      const decode = (response: HttpResponse): void => {
        if (descriptor.parallel && response.status >= 300 && response.status < 400) {
          const location = response.headers.location;
          if (location && redirectDepth < 5) {
            const nextUrl = new URL(location, descriptor.url).href;
            finish(() => {
              this.#execute({ ...descriptor, url: nextUrl }, signal, redirectDepth + 1)
                .then(resolve, reject);
            });
            return;
          }
        }
        if (response.status < 200 || response.status >= 300) {
          fail(new RequestError(`HTTP ${response.status}`, "http", response.status));
          return;
        }
        try {
          const value = descriptor.decode(response);
          localPhase(descriptor, "complete", response.body.length);
          finish(() => resolve(value));
        } catch (error) {
          fail(new RequestError(error instanceof Error ? error.message : "response decode failed", "decode"));
        }
      };
      const consumeStream = async (event: GmRequestResponse | GmRequestProgress): Promise<void> => {
        const stream = responseStream(event);
        if (!stream || streamStarted || settled) return;
        streamStarted = true;
        localPhase(descriptor, "stream-start");
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let body = "";
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            body += decoder.decode(chunk.value, { stream: true });
            localPhase(descriptor, "chunk", body.length);
            const response = normalizeResponse(event, descriptor.url, body);
            if (descriptor.onProgress?.(response) === true) {
              void reader.cancel().catch(() => undefined);
              decode(completedStreamResponse(response));
              return;
            }
          }
          body += decoder.decode();
          decode(normalizeResponse(event, descriptor.url, body));
        } catch (error) {
          fail(new RequestError(error instanceof Error ? error.message : "response stream failed", "network"));
        }
      };

      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(onTimeout, descriptor.timeoutMs ?? 20_000);
      localPhase(descriptor, "dispatch");
      const streaming = descriptor.stream === true && descriptor.onProgress !== undefined;
      const options: GmRequestOptions = {
        method: descriptor.method,
        url: descriptor.url,
        timeout: descriptor.timeoutMs ?? 20_000,
        anonymous: descriptor.anonymous ?? true,
        ...(streaming && descriptor.parallel ? { redirect: "manual" as const } : {}),
        responseType: streaming ? "stream" : "text",
        ...(streaming ? { onloadstart: (event: GmRequestProgress) => { void consumeStream(event); } } : {}),
        onload: (event) => {
          if (settled || streamStarted) return;
          const stream = responseStream(event);
          if (stream) {
            void consumeStream(event);
            return;
          }
          const response = normalizeResponse(event, descriptor.url);
          if (response.body) descriptor.onProgress?.(response);
          decode(response);
        },
        onerror: () => fail(new RequestError("network request failed", "network")),
        ontimeout: onTimeout,
        onabort: () => {
          if (!settled) fail(new RequestError("network request aborted", "aborted"));
        },
        ...(descriptor.headers ? { headers: descriptor.headers } : {}),
        ...(descriptor.body !== undefined ? { data: descriptor.body } : {}),
      };
      try {
        handle = GM_xmlhttpRequest(options);
      } catch (error) {
        fail(new RequestError(error instanceof Error ? error.message : "network request failed", "network"));
      }
    });
  }
}
