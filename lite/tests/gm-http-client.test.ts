import { afterEach, describe, expect, it, vi } from "vitest";
import { GmHttpClient } from "../src/network/gm-http-client";
import { RequestScheduler } from "../src/network/request-scheduler";

afterEach(() => vi.unstubAllGlobals());

describe("GmHttpClient progress", () => {
  it("buffers finite streamed responses as text on X Browser without calling the blocking bridge", async () => {
    let options: GmRequestOptions | undefined;
    const nativeRead = vi.fn();
    vi.stubGlobal("window", { mbrowser: { GM_readStream: nativeRead } });
    vi.stubGlobal("GM_xmlhttpRequest", (request: GmRequestOptions) => { options = request; return { abort: vi.fn() }; });
    const progress = vi.fn();
    const pending = new GmHttpClient().request({
      key: "x-browser:stream", lane: "ai", method: "POST", url: "https://example.com/stream",
      stream: true, onProgress: progress, decode: (response) => response.body,
    });
    expect(options?.responseType).toBe("text");
    expect(options?.onloadstart).toBeUndefined();
    const body = 'data: {"text":"done"}\n\ndata: [DONE]\n\n';
    options?.onload({ status: 200, statusText: "OK", responseHeaders: "content-type: text/event-stream", responseText: body });
    await expect(pending).resolves.toBe(body);
    expect(progress).toHaveBeenCalledOnce();
    expect(nativeRead).not.toHaveBeenCalled();
  });

  it("reads fetch-mode streams while enabling Tampermonkey MV3 parallel dispatch", async () => {
    let options: GmRequestOptions | undefined;
    vi.stubGlobal("GM_xmlhttpRequest", (request: GmRequestOptions): GmRequestHandle => {
      options = request;
      return { abort: vi.fn() };
    });
    const scheduler = new RequestScheduler(8);
    const progress: string[] = [];
    const pending = new GmHttpClient(scheduler).request({
      key: "stream:responses",
      lane: "ai",
      method: "POST",
      url: "https://example.com/v1/responses",
      parallel: true,
      stream: true,
      onProgress: (response) => { progress.push(response.body); },
      decode: (response) => response.body,
    });
    await vi.waitFor(() => expect(options).toBeDefined());
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller; },
    });
    expect(options).toMatchObject({ responseType: "stream", redirect: "manual", anonymous: true });
    options?.onloadstart?.({
      status: 200,
      statusText: "OK",
      responseHeaders: "content-type: text/event-stream",
      response: stream,
      finalUrl: "https://example.com/v1/responses",
    });
    streamController?.enqueue(new TextEncoder().encode("data: first\n\n"));
    await vi.waitFor(() => expect(progress).toEqual(["data: first\n\n"]));
    streamController?.enqueue(new TextEncoder().encode("data: second\n\n"));
    streamController?.close();

    await expect(pending).resolves.toBe("data: first\n\ndata: second\n\n");
    expect(progress).toEqual(["data: first\n\n", "data: first\n\ndata: second\n\n"]);
    scheduler.destroy();
  });

  it("falls back to one final progress update when stream callbacks are unavailable", async () => {
    let options: GmRequestOptions | undefined;
    vi.stubGlobal("GM_xmlhttpRequest", (request: GmRequestOptions): GmRequestHandle => {
      options = request;
      return { abort: vi.fn() };
    });
    const scheduler = new RequestScheduler(1);
    const progress: string[] = [];
    const pending = new GmHttpClient(scheduler).request({
      key: "stream:test",
      lane: "ai",
      method: "POST",
      url: "https://example.com/v1/chat/completions",
      onProgress: (response) => { progress.push(response.body); },
      decode: (response) => response.body,
    });
    await vi.waitFor(() => expect(options).toBeDefined());
    const response = (responseText: string): GmRequestResponse => ({
      status: 200,
      statusText: "OK",
      responseHeaders: "content-type: text/event-stream",
      responseText,
      finalUrl: "https://example.com/v1/chat/completions",
    });
    options?.onload(response("data: first\n\ndata: second\n\ndata: [DONE]\n\n"));

    await expect(pending).resolves.toContain("[DONE]");
    expect(progress).toEqual(["data: first\n\ndata: second\n\ndata: [DONE]\n\n"]);
    scheduler.destroy();
  });

  it("keeps non-streaming parallel work on Tampermonkey's text response path", async () => {
    let options: GmRequestOptions | undefined;
    vi.stubGlobal("GM_xmlhttpRequest", (request: GmRequestOptions): GmRequestHandle => {
      options = request;
      return { abort: vi.fn() };
    });
    const scheduler = new RequestScheduler(8);
    const pending = new GmHttpClient(scheduler).request({
      key: "text:responses",
      lane: "ai",
      method: "POST",
      url: "http://127.0.0.1:8317/v1/responses",
      parallel: true,
      stream: false,
      decode: (response) => response.body,
    });
    await vi.waitFor(() => expect(options).toBeDefined());
    expect(options).toMatchObject({ responseType: "text", anonymous: true });
    expect(options).not.toHaveProperty("redirect");
    options?.onload({
      status: 200,
      statusText: "OK",
      responseHeaders: "content-type: application/json",
      responseText: '{"output":[]}',
      finalUrl: "http://127.0.0.1:8317/v1/responses",
    });

    await expect(pending).resolves.toBe('{"output":[]}');
    scheduler.destroy();
  });

  it("completes a fetch-mode stream when its decoder sees the terminal event", async () => {
    let options: GmRequestOptions | undefined;
    let streamCancelled = false;
    vi.stubGlobal("GM_xmlhttpRequest", (request: GmRequestOptions): GmRequestHandle => {
      options = request;
      return { abort: vi.fn() };
    });
    const scheduler = new RequestScheduler(1);
    const pending = new GmHttpClient(scheduler).request({
      key: "stream:terminal",
      lane: "ai",
      method: "POST",
      url: "http://127.0.0.1:8317/v1/responses",
      parallel: true,
      stream: true,
      onProgress: (response) => response.body.includes("response.completed"),
      decode: (response) => response.body,
    });
    await vi.waitFor(() => expect(options).toBeDefined());
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { streamController = controller; },
      cancel() { streamCancelled = true; },
    });
    options?.onloadstart?.({
      status: 0,
      statusText: "",
      responseHeaders: "content-type: text/event-stream",
      response: stream,
      finalUrl: "http://127.0.0.1:8317/v1/responses",
    });
    streamController?.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"译文"}\n\n'));
    streamController?.enqueue(new TextEncoder().encode('data: {"type":"response.completed","response":{"output":[]}}\n\n'));

    await expect(pending).resolves.toContain("response.completed");
    await vi.waitFor(() => expect(streamCancelled).toBe(true));
    scheduler.destroy();
  });
});
