import { LifecycleScope } from "../kernel/lifecycle";
import { supportsGmResponseStreams } from "../network/gm-stream-support";

const HN_UPDATES_STREAM_URL = "https://hacker-news.firebaseio.com/v0/updates.json";

export interface HnRealtimeSource extends EventTarget {
  close(): void;
}

export type HnRealtimeSourceFactory = (url: string) => HnRealtimeSource;

export interface HnRealtimeCallbacks {
  readonly onItemsChanged: (ids: readonly number[]) => void;
  readonly onConnected?: () => void;
  readonly onReconnecting?: () => void;
  readonly onUnavailable?: (reason: string) => void;
}

interface FirebaseStreamEnvelope {
  readonly path: string;
  readonly data: unknown;
}

function positiveIds(value: unknown): readonly number[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.filter((id): id is number => Number.isSafeInteger(id) && id > 0));
}

function decodeChangedIds(event: Event): readonly number[] {
  if (!(event instanceof MessageEvent) || typeof event.data !== "string") return Object.freeze([]);
  const value = JSON.parse(event.data) as unknown;
  if (!value || typeof value !== "object") return Object.freeze([]);
  const envelope = value as Partial<FirebaseStreamEnvelope>;
  if (typeof envelope.path !== "string") return Object.freeze([]);
  if (envelope.path === "/items") return positiveIds(envelope.data);
  if (envelope.path.startsWith("/items/") && Number.isSafeInteger(envelope.data) && (envelope.data as number) > 0) {
    return Object.freeze([envelope.data as number]);
  }
  if (envelope.path !== "/" || !envelope.data || typeof envelope.data !== "object") return Object.freeze([]);
  return positiveIds((envelope.data as { readonly items?: unknown }).items);
}

function responseStream(event: GmRequestProgress | GmRequestResponse): ReadableStream<Uint8Array> | null {
  const target = "target" in event ? event.target : undefined;
  const candidates = [event.response, target?.response];
  return candidates.find((value): value is ReadableStream<Uint8Array> =>
    Boolean(value && typeof (value as { readonly getReader?: unknown }).getReader === "function")) ?? null;
}

class GmHnRealtimeSource extends EventTarget implements HnRealtimeSource {
  #handle: GmRequestHandle | null = null;
  #reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  #reconnectTimer: number | null = null;
  #reconnectAttempt = 0;
  #buffer = "";
  #closed = false;

  constructor(
    readonly document: Document,
    readonly url: string,
  ) {
    super();
    this.#connect();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#reconnectTimer !== null) this.document.defaultView?.clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    void this.#reader?.cancel().catch(() => undefined);
    this.#reader = null;
    this.#handle?.abort();
    this.#handle = null;
  }

  #connect(): void {
    if (this.#closed) return;
    this.#buffer = "";
    let streamStarted = false;
    const consume = (event: GmRequestProgress | GmRequestResponse): void => {
      if (this.#closed || streamStarted) return;
      const stream = responseStream(event);
      if (!stream) return;
      streamStarted = true;
      this.#reconnectAttempt = 0;
      this.dispatchEvent(new Event("open"));
      void this.#consume(stream);
    };
    const reconnect = (): void => {
      if (!this.#closed) this.#scheduleReconnect();
    };
    try {
      this.#handle = GM_xmlhttpRequest({
        method: "GET",
        url: this.url,
        anonymous: true,
        headers: { Accept: "text/event-stream" },
        responseType: "stream",
        onloadstart: consume,
        onload: (event) => {
          consume(event);
          if (!streamStarted) reconnect();
        },
        onerror: reconnect,
        ontimeout: reconnect,
        onabort: reconnect,
      });
    } catch {
      reconnect();
    }
  }

  async #consume(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    this.#reader = reader;
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done || this.#closed) break;
        this.#consumeText(decoder.decode(chunk.value, { stream: true }));
      }
      if (!this.#closed) this.#consumeText(decoder.decode());
    } catch {
      // A broken stream is recovered through the bounded reconnect path below.
    } finally {
      if (this.#reader === reader) this.#reader = null;
      if (!this.#closed) this.#scheduleReconnect();
    }
  }

  #consumeText(text: string): void {
    this.#buffer += text;
    for (;;) {
      const boundary = this.#buffer.search(/\r?\n\r?\n/);
      if (boundary < 0) return;
      const block = this.#buffer.slice(0, boundary);
      const separator = this.#buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n";
      this.#buffer = this.#buffer.slice(boundary + separator.length);
      let eventName = "message";
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) eventName = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length > 0) this.dispatchEvent(new MessageEvent(eventName, { data: data.join("\n") }));
    }
  }

  #scheduleReconnect(): void {
    if (this.#closed || this.#reconnectTimer !== null) return;
    this.dispatchEvent(new Event("error"));
    const delay = Math.min(30_000, 1_000 * (2 ** Math.min(this.#reconnectAttempt, 5)));
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = this.document.defaultView?.setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay) ?? null;
  }
}

export class HnRealtimeAdapter {
  constructor(readonly sourceFactory?: HnRealtimeSourceFactory) {}

  static fromDocument(document: Document): HnRealtimeAdapter {
    return new HnRealtimeAdapter(
      typeof GM_xmlhttpRequest === "function" && supportsGmResponseStreams(document.defaultView)
        ? (url) => new GmHnRealtimeSource(document, url)
        : undefined,
    );
  }

  subscribe(scope: LifecycleScope, callbacks: HnRealtimeCallbacks): boolean {
    if (!this.sourceFactory || scope.destroyed) return false;
    let source: HnRealtimeSource;
    try {
      source = this.sourceFactory(HN_UPDATES_STREAM_URL);
    } catch (error) {
      callbacks.onUnavailable?.(error instanceof Error ? error.message : "HN 实时连接创建失败");
      return false;
    }
    scope.add(() => source.close());
    scope.listen(source, "open", () => callbacks.onConnected?.());
    scope.listen(source, "error", () => callbacks.onReconnecting?.());
    const onData = (event: Event): void => {
      try {
        const ids = decodeChangedIds(event);
        if (ids.length > 0) callbacks.onItemsChanged(ids);
      } catch {
        // Ignore one malformed Firebase event; EventSource keeps the live connection intact.
      }
    };
    scope.listen(source, "put", onData);
    scope.listen(source, "patch", onData);
    const onUnavailable = (): void => {
      callbacks.onUnavailable?.("HN 实时流已被服务端取消");
      source.close();
    };
    scope.listen(source, "cancel", onUnavailable);
    scope.listen(source, "auth_revoked", onUnavailable);
    return true;
  }
}
