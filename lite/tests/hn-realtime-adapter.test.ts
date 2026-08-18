// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { HnRealtimeAdapter } from "../src/hn-api/hn-realtime-adapter";
import { LifecycleScope } from "../src/kernel/lifecycle";

afterEach(() => {
  vi.unstubAllGlobals();
});

class FakeRealtimeSource extends EventTarget {
  closed = false;

  close(): void {
    this.closed = true;
  }

  emit(type: string, payload?: unknown): void {
    if (payload === undefined) this.dispatchEvent(new Event(type));
    else this.dispatchEvent(new MessageEvent(type, { data: JSON.stringify(payload) }));
  }
}

describe("HnRealtimeAdapter", () => {
  it("uses the userscript streaming gateway instead of CSP-blocked EventSource", async () => {
    let options: GmRequestOptions | undefined;
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => { streamController = controller; },
    });
    const abort = vi.fn();
    vi.stubGlobal("GM_xmlhttpRequest", vi.fn((requestOptions: GmRequestOptions) => {
      options = requestOptions;
      queueMicrotask(() => requestOptions.onloadstart?.({ response: stream }));
      return { abort };
    }));
    const changed = vi.fn();
    const connected = vi.fn();
    const scope = new LifecycleScope();

    expect(HnRealtimeAdapter.fromDocument(document).subscribe(scope, {
      onItemsChanged: changed,
      onConnected: connected,
    })).toBe(true);
    await Promise.resolve();
    streamController?.enqueue(new TextEncoder().encode(
      'event: put\ndata: {"path":"/","data":{"items":[100,101]}}\n\n',
    ));
    await Promise.resolve();

    expect(options?.url).toBe("https://hacker-news.firebaseio.com/v0/updates.json");
    expect(options?.headers).toEqual({ Accept: "text/event-stream" });
    expect(options?.responseType).toBe("stream");
    expect(connected).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledWith([100, 101]);
    scope.destroy();
    expect(abort).toHaveBeenCalledOnce();
  });

  it("decodes Firebase update events and closes the stream with its lifecycle", () => {
    const source = new FakeRealtimeSource();
    const create = vi.fn(() => source);
    const changed = vi.fn();
    const connected = vi.fn();
    const reconnecting = vi.fn();
    const scope = new LifecycleScope();
    const adapter = new HnRealtimeAdapter(create);

    expect(adapter.subscribe(scope, {
      onItemsChanged: changed,
      onConnected: connected,
      onReconnecting: reconnecting,
    })).toBe(true);
    expect(create).toHaveBeenCalledWith("https://hacker-news.firebaseio.com/v0/updates.json");
    source.emit("open");
    source.emit("put", { path: "/", data: { items: [100, 101, "bad", -1] } });
    source.emit("patch", { path: "/items", data: [102, 103] });
    source.emit("patch", { path: "/items/0", data: 104 });
    source.emit("error");

    expect(connected).toHaveBeenCalledOnce();
    expect(reconnecting).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenNthCalledWith(1, [100, 101]);
    expect(changed).toHaveBeenNthCalledWith(2, [102, 103]);
    expect(changed).toHaveBeenNthCalledWith(3, [104]);
    scope.destroy();
    expect(source.closed).toBe(true);
    source.emit("put", { path: "/", data: { items: [105] } });
    expect(changed).toHaveBeenCalledTimes(3);
  });

  it("closes cancelled Firebase streams and reports the unavailable state", () => {
    const source = new FakeRealtimeSource();
    const unavailable = vi.fn();
    const scope = new LifecycleScope();
    new HnRealtimeAdapter(() => source).subscribe(scope, {
      onItemsChanged: vi.fn(),
      onUnavailable: unavailable,
    });

    source.emit("cancel");
    expect(source.closed).toBe(true);
    expect(unavailable).toHaveBeenCalledWith("HN 实时流已被服务端取消");
    scope.destroy();
  });
});
