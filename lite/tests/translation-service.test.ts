// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { AiCompletionClient } from "../src/ai/ai-completion-client";
import { CacheRepository } from "../src/cache/cache-repository";
import { MemoryCacheStore } from "../src/cache/cache-store";
import { RequestError, type HttpClient, type RequestDescriptor } from "../src/network/request-contract";
import { DEFAULT_SETTINGS } from "../src/settings/settings-store";
import { TranslationService, type CachedTranslation, type TranslationOutput } from "../src/translation/translation-service";
import { TranslationTaskManager } from "../src/translation/translation-task-manager";

class TranslationHttp implements HttpClient {
  readonly calls: string[] = [];
  readonly bodies: string[] = [];
  readonly keys: string[] = [];
  constructor(readonly failGoogle = false, readonly failMicrosoft = false) {}
  request<T>(descriptor: RequestDescriptor<T>): Promise<T> {
    this.calls.push(descriptor.url);
    this.bodies.push(descriptor.body ?? "");
    this.keys.push(descriptor.key);
    if (descriptor.url.includes("googleapis") && this.failGoogle) throw new Error("google down");
    if (descriptor.url.includes("microsofttranslator") && this.failMicrosoft) throw new Error("microsoft down");
    let body: string;
    if (descriptor.url.includes("googleapis")) {
      body = JSON.stringify(new URL(descriptor.url).searchParams.getAll("q").map((source) => [source]));
    }
    else if (descriptor.url.includes("translate/auth")) body = "token";
    else if (descriptor.url.includes("microsofttranslator")) {
      const values = JSON.parse(descriptor.body ?? "[]") as { Text: string }[];
      body = JSON.stringify(values.map((value) => ({ translations: [{ text: value.Text }] })));
    } else if (descriptor.url.endsWith("/models")) {
      body = JSON.stringify({ data: [{ id: "gpt-test" }, { id: "gpt-small" }] });
    } else {
      const request = JSON.parse(descriptor.body ?? "{}") as { input?: { content?: string }[] };
      const payload = JSON.parse(request.input?.at(-1)?.content ?? "[]") as unknown;
      const translations = Array.isArray(payload) ? payload.map((entry) => {
        if (typeof entry === "string") return entry;
        if (!entry || typeof entry !== "object") return "";
        const text = (entry as { readonly text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }) : [];
      const keyed = Array.isArray(payload) && payload.every((entry) => entry && typeof entry === "object" && typeof (entry as { readonly id?: unknown }).id === "string");
      const content = keyed
        ? JSON.stringify(Object.fromEntries((payload as { readonly id: string }[]).map((entry, index) => [entry.id, translations[index] ?? ""]).reverse()))
        : JSON.stringify(translations);
      body = JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: content }] }] });
    }
    return Promise.resolve(descriptor.decode({ status: 200, statusText: "OK", headers: {}, body, finalUrl: descriptor.url }));
  }
}

class FlakyAiHttp extends TranslationHttp {
  aiAttempts = 0;

  constructor(readonly firstFailure: "http" | "format") {
    super();
  }

  override request<T>(descriptor: RequestDescriptor<T>): Promise<T> {
    if (!descriptor.url.endsWith("/responses") || this.aiAttempts++ > 0) return super.request(descriptor);
    this.calls.push(descriptor.url);
    this.bodies.push(descriptor.body ?? "");
    this.keys.push(descriptor.key);
    if (this.firstFailure === "http") return Promise.reject(new RequestError("HTTP 502", "http", 502));
    const body = JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(["only one result"]) }] }] });
    return Promise.resolve(descriptor.decode({ status: 200, statusText: "OK", headers: {}, body, finalUrl: descriptor.url }));
  }
}

class FailingAiHttp extends TranslationHttp {
  override request<T>(descriptor: RequestDescriptor<T>): Promise<T> {
    if (!descriptor.url.endsWith("/responses")) return super.request(descriptor);
    this.calls.push(descriptor.url);
    this.bodies.push(descriptor.body ?? "");
    this.keys.push(descriptor.key);
    return Promise.reject(new RequestError("HTTP 502", "http", 502));
  }
}

class ParallelTranslationHttp extends TranslationHttp {
  googleAttempts = 0;
  releaseFirst: (() => void) | null = null;

  override request<T>(descriptor: RequestDescriptor<T>): Promise<T> {
    if (!descriptor.url.includes("googleapis") || this.googleAttempts++ !== 0) return super.request(descriptor);
    return new Promise<T>((resolve, reject) => {
      this.releaseFirst = () => { void super.request(descriptor).then(resolve, reject); };
    });
  }
}

class ParallelAiTranslationHttp extends TranslationHttp {
  aiAttempts = 0;
  releaseFirst: (() => void) | null = null;

  override request<T>(descriptor: RequestDescriptor<T>): Promise<T> {
    if (!descriptor.url.endsWith("/responses") || this.aiAttempts++ !== 0) return super.request(descriptor);
    return new Promise<T>((resolve, reject) => {
      this.releaseFirst = () => { void super.request(descriptor).then(resolve, reject); };
    });
  }
}

class StreamingAiHttp extends TranslationHttp {
  releaseRest: (() => void) | null = null;
  terminalSeen = false;

  override request<T>(descriptor: RequestDescriptor<T>): Promise<T> {
    if (!descriptor.url.endsWith("/responses")) return super.request(descriptor);
    this.calls.push(descriptor.url);
    this.bodies.push(descriptor.body ?? "");
    const request = JSON.parse(descriptor.body ?? "{}") as { readonly input?: readonly { readonly content?: string }[] };
    const entries = JSON.parse(request.input?.at(-1)?.content ?? "[]") as readonly { readonly id: string; readonly text: string }[];
    const first = entries[0];
    if (!first) return Promise.reject(new Error("stream fixture requires at least one entry"));
    const remaining = entries.slice(1);
    const firstContent = `{${JSON.stringify(first.id)}:${JSON.stringify(first.text)}${remaining.length > 0 ? "," : ""}`;
    const remainingContent = `${remaining.map((entry) => `${JSON.stringify(entry.id)}:${JSON.stringify(entry.text)}`).join(",")}}`;
    const event = (content: string) => `data: ${JSON.stringify({ type: "response.output_text.delta", delta: content })}\n\n`;
    let responseBody = event(firstContent);
    const response = () => ({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/event-stream" },
      body: responseBody,
      finalUrl: descriptor.url,
    });
    descriptor.onProgress?.(response());
    return new Promise<T>((resolve, reject) => {
      this.releaseRest = () => {
        responseBody += event(remainingContent);
        this.terminalSeen = descriptor.onProgress?.(response()) === true;
        try {
          resolve(descriptor.decode(response()));
        } catch (error) {
          reject(error instanceof Error ? error : new Error("stream decode failed"));
        }
      };
    });
  }
}

class TokenStreamingAiHttp extends TranslationHttp {
  releaseRest: (() => void) | null = null;

  override request<T>(descriptor: RequestDescriptor<T>): Promise<T> {
    if (!descriptor.url.endsWith("/responses")) return super.request(descriptor);
    this.calls.push(descriptor.url);
    this.bodies.push(descriptor.body ?? "");
    const event = (content: string) => `data: ${JSON.stringify({ type: "response.output_text.delta", delta: content })}\n\n`;
    let responseBody = event('{"section_0":"即时');
    const response = () => ({
      status: 200,
      statusText: "OK",
      headers: { "content-type": "text/event-stream" },
      body: responseBody,
      finalUrl: descriptor.url,
    });
    descriptor.onProgress?.(response());
    return new Promise<T>((resolve, reject) => {
      this.releaseRest = () => {
        responseBody += `${event('显示的完整译文"}')}data: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}\n\n`;
        descriptor.onProgress?.(response());
        try {
          resolve(descriptor.decode(response()));
        } catch (error) {
          reject(error instanceof Error ? error : new Error("stream decode failed"));
        }
      };
    });
  }
}

describe("TranslationService", () => {
  it("discovers models from the configured OpenAI-compatible endpoint", async () => {
    const http = new TranslationHttp();
    const models = await new AiCompletionClient(http).listModels({ ...DEFAULT_SETTINGS.ai, baseUrl: "http://127.0.0.1:8317/v1", apiKey: "test-key" });
    expect(models).toEqual(["gpt-test", "gpt-small"]);
    expect(http.calls[0]).toBe("http://127.0.0.1:8317/v1/models");
  });

  it("uses Google for the normal public path", async () => {
    const http = new TranslationHttp();
    const tasks = new TranslationTaskManager();
    const service = new TranslationService(document, http, tasks, new CacheRepository(new MemoryCacheStore()), new AiCompletionClient(http));
    const outputs = await service.translateMany([{ id: 1, html: "Please run <code>npm test</code> before you continue." }], DEFAULT_SETTINGS, new AbortController().signal);
    expect(outputs[0]?.provider).toBe("google");
    expect(http.calls).toHaveLength(1);
    tasks.destroy();
  });

  it("translates opted-in short host titles and comments through the configured provider", async () => {
    const http = new TranslationHttp();
    const tasks = new TranslationTaskManager();
    const service = new TranslationService(document, http, tasks, new CacheRepository(new MemoryCacheStore()), new AiCompletionClient(http));

    await expect(service.translateMany(
      [{ id: 1, html: "Delta" }],
      DEFAULT_SETTINGS,
      new AbortController().signal,
    )).resolves.toEqual([]);
    expect(http.calls).toHaveLength(0);

    const outputs = await service.translateMany([
      { id: 1, html: "Delta", translateShortText: true },
      { id: 2, html: "Thanks", translateShortText: true },
    ], DEFAULT_SETTINGS, new AbortController().signal);

    expect(outputs.map((output) => output.id)).toEqual([1, 2]);
    expect(outputs.every((output) => output.provider === "google")).toBe(true);
    expect(http.calls).toHaveLength(1);
    tasks.destroy();
  });

  it("reuses the persisted translation cache without another provider request", async () => {
    const http = new TranslationHttp();
    const tasks = new TranslationTaskManager();
    const cache = new CacheRepository<CachedTranslation>(new MemoryCacheStore());
    const service = new TranslationService(document, http, tasks, cache, new AiCompletionClient(http));
    const input = [{ id: 1, html: "This complete sentence should be translated and cached for later reading." }];
    const first = await service.translateMany(input, DEFAULT_SETTINGS, new AbortController().signal);
    const callsAfterFirst = http.calls.length;
    const second = await service.translateMany(input, DEFAULT_SETTINGS, new AbortController().signal);
    expect(second).toEqual(first);
    expect(http.calls).toHaveLength(callsAfterFirst);

    const refreshed = await service.translateMany(
      input.map((entry) => ({ ...entry, forceRefresh: true })),
      DEFAULT_SETTINGS,
      new AbortController().signal,
    );
    expect(refreshed).toEqual(first);
    expect(http.calls).toHaveLength(callsAfterFirst + 1);
    tasks.destroy();
  });

  it("translates paragraph and list sections with adjacent context while preserving structure", async () => {
    const http = new TranslationHttp();
    const tasks = new TranslationTaskManager();
    const service = new TranslationService(document, http, tasks, new CacheRepository(new MemoryCacheStore()), new AiCompletionClient(http));
    const html = "Opening context for this comment.<p>It refers to that context in the next paragraph.</p><ul><li>First related point in the list.</li><li>Second related point in the list.</li></ul>";
    const output = (await service.translateMany([{ id: 1, html }], DEFAULT_SETTINGS, new AbortController().signal))[0];
    expect(output?.html.match(/<p>/g)).toHaveLength(2);
    expect(output?.html.match(/<li>/g)).toHaveLength(2);
    const googleCalls = http.calls.filter((url) => url.includes("googleapis"));
    const sources = googleCalls.flatMap((url) => new URL(url).searchParams.getAll("q"));
    expect(googleCalls).toHaveLength(1);
    expect(sources).toHaveLength(4);
    expect(sources.every((source) => source.includes("⟦900000⟧") && source.includes("⟦900001⟧"))).toBe(true);
    expect(output?.html).not.toContain("900000");
    const bilingual = document.createElement("div");
    bilingual.innerHTML = output?.bilingualHtml ?? "";
    expect([...bilingual.querySelectorAll(".hnr-bilingual-original-section, .hnr-bilingual-translation-section")]
      .map((section) => section.classList.contains("hnr-bilingual-original-section") ? "original" : "translation"))
      .toEqual(["original", "translation", "original", "translation", "original", "translation", "original", "translation"]);
    tasks.destroy();
  });

  it("falls back Google to Microsoft and preserves protected code", async () => {
    const http = new TranslationHttp(true);
    const tasks = new TranslationTaskManager();
    const service = new TranslationService(document, http, tasks, new CacheRepository(new MemoryCacheStore()), new AiCompletionClient(http));
    const outputs = await service.translateMany([{ id: 1, html: "Please run <code>npm test</code> before you continue." }], DEFAULT_SETTINGS, new AbortController().signal);
    expect(outputs[0]?.provider).toBe("microsoft");
    expect(outputs[0]?.html).toContain("<code>npm test</code>");
    expect(http.calls.some((url) => url.includes("googleapis"))).toBe(true);
    expect(http.calls.some((url) => url.includes("microsofttranslator"))).toBe(true);
    tasks.destroy();
  });

  it("uses AI only when explicitly selected", async () => {
    const http = new TranslationHttp();
    const tasks = new TranslationTaskManager();
    const service = new TranslationService(document, http, tasks, new CacheRepository(new MemoryCacheStore()), new AiCompletionClient(http));
    const settings = { ...DEFAULT_SETTINGS, translationProvider: "ai" as const, ai: { ...DEFAULT_SETTINGS.ai, apiKey: "test-key" } };
    const outputs = await service.translateMany([{ id: 1, html: "Please run <code>npm test</code> before you continue." }], settings, new AbortController().signal);
    expect(outputs[0]?.provider).toBe("ai");
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]).toBe("https://api.openai.com/v1/responses");
    tasks.destroy();
  });

  it("packs visible comments into one AI request while preserving source order", async () => {
    const http = new TranslationHttp();
    const tasks = new TranslationTaskManager();
    const service = new TranslationService(document, http, tasks, new CacheRepository(new MemoryCacheStore()), new AiCompletionClient(http));
    const settings = { ...DEFAULT_SETTINGS, translationProvider: "ai" as const, ai: { ...DEFAULT_SETTINGS.ai, apiKey: "test-key" } };
    const outputs = await service.translateMany(Array.from({ length: 12 }, (_, index) => ({
      id: index + 1,
      html: `Comment ${index + 1}. ${"This detailed English paragraph should be translated independently. ".repeat(4)}`,
    })), settings, new AbortController().signal);
    const requests = http.bodies.map((body) => {
      const request = JSON.parse(body) as { readonly input?: readonly { readonly content?: string }[] };
      return JSON.parse(request.input?.at(-1)?.content ?? "[]") as readonly { readonly id?: string; readonly text?: string }[];
    });
    expect(outputs.map((output) => output.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.map((entry) => entry.id)).toEqual(Array.from({ length: 12 }, (_, index) => `section_${index}`));
    expect(requests[0]?.map((entry) => entry.text?.match(/Comment (\d+)/)?.[1])).toEqual(
      Array.from({ length: 12 }, (_, index) => String(index + 1)),
    );
    expect(http.bodies.every((body) => {
      const request = JSON.parse(body) as { readonly reasoning?: { readonly effort?: unknown }; readonly reasoning_effort?: unknown };
      return request.reasoning?.effort === "low" && request.reasoning_effort === undefined;
    })).toBe(true);
    tasks.destroy();
  });

  it("promotes an active packed prefetch request when one of its comments becomes visible", async () => {
    const http = new ParallelAiTranslationHttp();
    const tasks = new TranslationTaskManager();
    const promote = vi.spyOn(tasks, "promote");
    const service = new TranslationService(document, http, tasks, new CacheRepository(new MemoryCacheStore()), new AiCompletionClient(http));
    const settings = { ...DEFAULT_SETTINGS, translationProvider: "ai" as const, ai: { ...DEFAULT_SETTINGS.ai, apiKey: "test-key" } };
    const controller = new AbortController();
    const pending = service.translateMany([
      { id: 101, html: "This first prefetched comment has enough text to translate." },
      { id: 202, html: "This second prefetched comment later enters the visible viewport." },
    ], settings, controller.signal, "prefetch");

    await vi.waitFor(() => expect(http.releaseFirst).toBeTypeOf("function"));
    expect(service.promoteInputs([202], "visible")).toBe(1);
    expect(promote).toHaveBeenCalledOnce();
    expect(promote.mock.calls[0]?.[1]).toBe("visible");
    controller.abort(new Error("test complete"));
    await expect(pending).rejects.toThrow("test complete");
    tasks.destroy();
  });

  it("keeps identical paragraphs independently addressable inside a shared AI batch", async () => {
    const http = new TranslationHttp();
    const tasks = new TranslationTaskManager();
    const service = new TranslationService(document, http, tasks, new CacheRepository(new MemoryCacheStore()), new AiCompletionClient(http));
    const settings = { ...DEFAULT_SETTINGS, translationProvider: "ai" as const, ai: { ...DEFAULT_SETTINGS.ai, apiKey: "test-key" } };
    const html = "The same meaningful paragraph belongs to two different comments and must keep both request identities.";

    const outputs = await service.translateMany([
      { id: 101, html },
      { id: 202, html },
    ], settings, new AbortController().signal);

    expect(http.keys).toHaveLength(1);
    expect(outputs.map((output) => output.id)).toEqual([101, 202]);
    const request = JSON.parse(http.bodies[0] ?? "{}") as { readonly input?: readonly { readonly content?: string }[] };
    const entries = JSON.parse(request.input?.at(-1)?.content ?? "[]") as readonly { readonly id: string; readonly text: string }[];
    expect(entries.map((entry) => entry.id)).toEqual(["section_0", "section_1"]);
    expect(entries.map((entry) => entry.text)).toEqual([html, html]);
    tasks.destroy();
  });

  it("separates a quoted excerpt from the longer parent paragraph in AI batches", async () => {
    const http = new TranslationHttp();
    const tasks = new TranslationTaskManager();
    const service = new TranslationService(document, http, tasks, new CacheRepository(new MemoryCacheStore()), new AiCompletionClient(http));
    const settings = { ...DEFAULT_SETTINGS, translationProvider: "ai" as const, ai: { ...DEFAULT_SETTINGS.ai, apiKey: "test-key" } };
    const sharedExcerpt = "But unless you know the prompt, you don't fully know which choice the model faces. Surely a lot of coding space is wasted compensating for that uncertainty.";
    const parentContinuation = " Exotic prompts (\"Use no more than five E's in four consecutive words anywhere in the text\") seem like they will confuse the hell out of attempts to extract the bits from the output text alone.";

    const outputs = await service.translateMany([
      {
        id: 49329645,
        html: `A way to think of it is that any time the model faces a choice, it leaks some fractional bits of information.<p>${sharedExcerpt}${parentContinuation}</p>`,
      },
      {
        id: 49330180,
        html: `&gt; ${sharedExcerpt}<p>When you only need to encode one bit, the signal to noise ratio can be very low.</p>`,
      },
    ], settings, new AbortController().signal, "visible");

    const requests = http.bodies.map((body) => {
      const request = JSON.parse(body) as { readonly input?: readonly { readonly content?: string }[] };
      return JSON.parse(request.input?.at(-1)?.content ?? "[]") as readonly { readonly text: string }[];
    });
    expect(requests).toHaveLength(2);
    expect(requests.every((entries) => {
      const texts = entries.map((entry) => entry.text.replace(/^>\s*/, ""));
      return !(texts.includes(sharedExcerpt) && texts.includes(`${sharedExcerpt}${parentContinuation}`));
    })).toBe(true);
    expect(outputs.find((output) => output.id === 49330180)?.text).not.toContain("Exotic prompts");
    tasks.destroy();
  });

  it("packs paragraphs across visible comments in round-robin comment order", async () => {
    const http = new TranslationHttp();
    const tasks = new TranslationTaskManager();
    const service = new TranslationService(document, http, tasks, new CacheRepository(new MemoryCacheStore()), new AiCompletionClient(http));
    const settings = { ...DEFAULT_SETTINGS, translationProvider: "ai" as const, ai: { ...DEFAULT_SETTINGS.ai, apiKey: "test-key" } };

    await service.translateMany([
      { id: 101, html: "First comment opening paragraph has enough English text.<p>First comment later paragraph also needs translation.</p>" },
      { id: 202, html: "Second comment opening paragraph has enough English text.<p>Second comment later paragraph also needs translation.</p>" },
    ], settings, new AbortController().signal, "visible");

    expect(http.keys).toHaveLength(1);
    const entriesPerRequest = http.bodies.map((body) => {
      const request = JSON.parse(body) as { readonly input?: readonly { readonly content?: string }[] };
      return JSON.parse(request.input?.at(-1)?.content ?? "[]") as readonly { readonly id: string; readonly text: string }[];
    });
    expect(entriesPerRequest.map((entries) => entries.map((entry) => entry.id))).toEqual([
      ["section_0", "section_1", "section_2", "section_3"],
    ]);
    expect(entriesPerRequest[0]?.map((entry) => entry.text.match(/(First|Second) comment (opening|later)/)?.slice(1).join(" ")))
      .toEqual(["First opening", "Second opening", "First later", "Second later"]);
    tasks.destroy();
  });

  it("keeps a visible multi-section comment in one request while it fits the character limit", async () => {
    const http = new TranslationHttp();
    const tasks = new TranslationTaskManager();
    const service = new TranslationService(document, http, tasks, new CacheRepository(new MemoryCacheStore()), new AiCompletionClient(http));
    const settings = { ...DEFAULT_SETTINGS, translationProvider: "ai" as const, ai: { ...DEFAULT_SETTINGS.ai, apiKey: "test-key" } };
    const html = Array.from(
      { length: 9 },
      (_, index) => `<p>Visible paragraph ${index + 1} contains enough English text for translation.</p>`,
    ).join("");

    await service.translateMany([{ id: 101, html }], settings, new AbortController().signal, "visible");

    expect(http.keys).toHaveLength(1);
    const request = JSON.parse(http.bodies[0] ?? "{}") as { readonly input?: readonly { readonly content?: string }[] };
    const entries = JSON.parse(request.input?.at(-1)?.content ?? "[]") as readonly { readonly id: string }[];
    expect(entries.map((entry) => entry.id)).toEqual([
      "section_0", "section_1", "section_2", "section_3", "section_4",
      "section_5", "section_6", "section_7", "section_8",
    ]);
    tasks.destroy();
  });

  it("packs background AI paragraphs to the same character budget used by visible work", async () => {
    const http = new TranslationHttp();
    const tasks = new TranslationTaskManager();
    const service = new TranslationService(document, http, tasks, new CacheRepository(new MemoryCacheStore()), new AiCompletionClient(http));
    const settings = { ...DEFAULT_SETTINGS, translationProvider: "ai" as const, ai: { ...DEFAULT_SETTINGS.ai, apiKey: "test-key" } };
    const html = Array.from(
      { length: 9 },
      (_, index) => `<p>Background paragraph ${index + 1} contains enough English text for translation.</p>`,
    ).join("");

    await service.translateMany([{ id: 202, html }], settings, new AbortController().signal, "prefetch");

    expect(http.keys).toHaveLength(1);
    const entryCounts = http.bodies.map((body) => {
      const request = JSON.parse(body) as { readonly input?: readonly { readonly content?: string }[] };
      return (JSON.parse(request.input?.at(-1)?.content ?? "[]") as readonly unknown[]).length;
    });
    expect(entryCounts).toEqual([9]);
    tasks.destroy();
  });

  it("retains bounded foreground batches for public translation URLs", async () => {
    const http = new TranslationHttp();
    const tasks = new TranslationTaskManager();
    const service = new TranslationService(document, http, tasks, new CacheRepository(new MemoryCacheStore()), new AiCompletionClient(http));
    const html = Array.from(
      { length: 9 },
      (_, index) => `<p>Public paragraph ${index + 1} contains enough English text for translation.</p>`,
    ).join("");

    await service.translateMany([{ id: 203, html }], DEFAULT_SETTINGS, new AbortController().signal, "visible");

    const googleCalls = http.calls.filter((url) => url.includes("googleapis"));
    expect(googleCalls).toHaveLength(2);
    expect(googleCalls.map((url) => new URL(url).searchParams.getAll("q").length)).toEqual([6, 3]);
    tasks.destroy();
  });

  it("still splits a visible comment when its combined request exceeds the character limit", async () => {
    const http = new TranslationHttp();
    const tasks = new TranslationTaskManager();
    const service = new TranslationService(document, http, tasks, new CacheRepository(new MemoryCacheStore()), new AiCompletionClient(http));
    const settings = { ...DEFAULT_SETTINGS, translationProvider: "ai" as const, ai: { ...DEFAULT_SETTINGS.ai, apiKey: "test-key" } };
    const html = Array.from(
      { length: 3 },
      (_, index) => `<p>Visible long paragraph ${index + 1}. ${"Detailed English translation text. ".repeat(95)}</p>`,
    ).join("");

    await service.translateMany([{ id: 303, html }], settings, new AbortController().signal, "visible");

    expect(http.keys).toHaveLength(2);
    const entryCounts = http.bodies.map((body) => {
      const request = JSON.parse(body) as { readonly input?: readonly { readonly content?: string }[] };
      return (JSON.parse(request.input?.at(-1)?.content ?? "[]") as readonly unknown[]).length;
    });
    expect(entryCounts).toEqual([2, 1]);
    tasks.destroy();
  });

  it("starts independent oversized AI packs in parallel", async () => {
    const http = new ParallelAiTranslationHttp();
    const tasks = new TranslationTaskManager({ maxConcurrent: 6 });
    const service = new TranslationService(document, http, tasks, new CacheRepository(new MemoryCacheStore()), new AiCompletionClient(http));
    const settings = { ...DEFAULT_SETTINGS, translationProvider: "ai" as const, ai: { ...DEFAULT_SETTINGS.ai, apiKey: "test-key" } };
    const rendered: number[] = [];
    let settled = false;
    const pending = service.translateMany(Array.from({ length: 6 }, (_, index) => ({
      id: index + 1,
      html: `Comment ${index + 1}. ${"Detailed English text keeps this request in an independent bounded pack. ".repeat(90)}`,
    })), settings, new AbortController().signal, "prefetch", undefined, (output) => {
      if (output.complete) rendered.push(output.id);
    })
      .finally(() => { settled = true; });

    await vi.waitFor(() => {
      expect(http.aiAttempts).toBe(6);
      expect(rendered).toEqual([2, 3, 4, 5, 6]);
      expect(http.releaseFirst).toBeTypeOf("function");
    });
    expect(settled).toBe(false);
    http.releaseFirst?.();
    expect((await pending).map((output) => output.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rendered).toEqual([2, 3, 4, 5, 6, 1]);
    tasks.destroy();
  });

  it("publishes a completed paragraph from an AI SSE stream before the request finishes", async () => {
    const http = new StreamingAiHttp();
    const tasks = new TranslationTaskManager();
    const service = new TranslationService(document, http, tasks, new CacheRepository(new MemoryCacheStore()), new AiCompletionClient(http));
    const settings = { ...DEFAULT_SETTINGS, translationProvider: "ai" as const, ai: { ...DEFAULT_SETTINGS.ai, apiKey: "test-key" } };
    const rendered: number[] = [];
    let settled = false;
    const pending = service.translateMany([
      { id: 1, html: "This paragraph should render from the stream before its request finishes." },
    ], settings, new AbortController().signal, "visible", undefined, (output) => {
      if (output.complete) rendered.push(output.id);
    })
      .finally(() => { settled = true; });

    await vi.waitFor(() => {
      expect(rendered).toContain(1);
      expect(http.releaseRest).toBeTypeOf("function");
    });
    expect(settled).toBe(false);
    expect(JSON.parse(http.bodies[0] ?? "{}")).toMatchObject({ stream: true, store: false, reasoning: { effort: "low" } });
    http.releaseRest?.();
    await expect(pending).resolves.toEqual([expect.objectContaining({ id: 1 })]);
    expect(rendered).toContain(1);
    expect(http.terminalSeen).toBe(true);
    tasks.destroy();
  });

  it("optimistically publishes an unfinished AI JSON value before the section closes", async () => {
    const http = new TokenStreamingAiHttp();
    const tasks = new TranslationTaskManager();
    const service = new TranslationService(document, http, tasks, new CacheRepository(new MemoryCacheStore()), new AiCompletionClient(http));
    const settings = { ...DEFAULT_SETTINGS, translationProvider: "ai" as const, ai: { ...DEFAULT_SETTINGS.ai, apiKey: "test-key" } };
    const rendered: TranslationOutput[] = [];
    let settled = false;
    const pending = service.translateMany([
      { id: 1, html: "This long paragraph should become visible as soon as its first translated tokens arrive." },
    ], settings, new AbortController().signal, "visible", undefined, (output) => rendered.push(output))
      .finally(() => { settled = true; });

    await vi.waitFor(() => {
      expect(rendered[0]?.html).toContain("hnr-translation-placeholder");
      expect(rendered.find((output) => output.text === "即时")).toMatchObject({ id: 1, complete: false });
      expect(rendered.find((output) => output.text === "即时")?.html).toContain("is-streaming");
      expect(http.releaseRest).toBeTypeOf("function");
    });
    expect(settled).toBe(false);
    http.releaseRest?.();
    await expect(pending).resolves.toEqual([expect.objectContaining({ id: 1, text: "即时显示的完整译文", complete: true })]);
    expect(rendered.at(-1)).toMatchObject({ id: 1, complete: true });
    tasks.destroy();
  });

  it("publishes the first completed section of a multi-paragraph comment", async () => {
    const http = new StreamingAiHttp();
    const tasks = new TranslationTaskManager();
    const service = new TranslationService(document, http, tasks, new CacheRepository(new MemoryCacheStore()), new AiCompletionClient(http));
    const settings = { ...DEFAULT_SETTINGS, translationProvider: "ai" as const, ai: { ...DEFAULT_SETTINGS.ai, apiKey: "test-key" } };
    const rendered: TranslationOutput[] = [];
    const pending = service.translateMany([{
      id: 1,
      html: "The first paragraph should render without waiting.<p>The second paragraph is deliberately delayed.</p>",
    }], settings, new AbortController().signal, "visible", undefined, (output) => rendered.push(output));

    await vi.waitFor(() => {
      const partial = rendered.find((output) => !output.complete && output.text);
      expect(partial?.html).toContain("hnr-translation-placeholder");
      expect(partial?.bilingualHtml).toContain("The second paragraph");
      const bilingual = document.createElement("div");
      bilingual.innerHTML = partial?.bilingualHtml ?? "";
      expect(bilingual.querySelectorAll(".hnr-bilingual-translation-section")).toHaveLength(2);
      expect(bilingual.querySelectorAll(".hnr-bilingual-translation-section.is-loading")).toHaveLength(1);
    });
    http.releaseRest?.();
    await expect(pending).resolves.toEqual([expect.objectContaining({ id: 1, complete: true })]);
    tasks.destroy();
  });

  it("gives AI adjacent context without requiring context boundary tokens in its translations", async () => {
    const http = new TranslationHttp();
    const tasks = new TranslationTaskManager();
    const service = new TranslationService(document, http, tasks, new CacheRepository(new MemoryCacheStore()), new AiCompletionClient(http));
    const settings = { ...DEFAULT_SETTINGS, translationProvider: "ai" as const, ai: { ...DEFAULT_SETTINGS.ai, apiKey: "test-key" } };
    const html = "Unfortunately, this browser still cannot clear all site data automatically.<p>Another browser implemented this two years ago:</p><blockquote><i>Auto Shred can delete data when the last tab closes.</i></blockquote><p><a href='https://example.com/privacy'>https://example.com/privacy</a></p>";
    const output = (await service.translateMany([{ id: 1, html }], settings, new AbortController().signal))[0];
    const entries = http.bodies.flatMap((body) => {
      const request = JSON.parse(body) as { readonly input?: readonly { readonly content?: string }[] };
      return JSON.parse(request.input?.at(-1)?.content ?? "[]") as { readonly before: string; readonly text: string; readonly after: string }[];
    });
    expect(entries).toHaveLength(3);
    expect(entries.some((entry) => entry.before || entry.after)).toBe(true);
    expect(entries.every((entry) => !entry.text.includes("⟦900000⟧") && !entry.text.includes("⟦900001⟧"))).toBe(true);
    expect(output?.html).toContain("https://example.com/privacy");
    expect(output?.html).not.toContain("900000");
    tasks.destroy();
  });

  it.each(["http", "format"] as const)("recovers an AI %s packed-batch failure with one shared retry", async (firstFailure) => {
    const http = new FlakyAiHttp(firstFailure);
    const tasks = new TranslationTaskManager();
    const service = new TranslationService(document, http, tasks, new CacheRepository(new MemoryCacheStore()), new AiCompletionClient(http));
    const settings = { ...DEFAULT_SETTINGS, translationProvider: "ai" as const, ai: { ...DEFAULT_SETTINGS.ai, apiKey: "test-key" } };
    const outputs = await service.translateMany([
      { id: 1, html: "This first visible comment has enough text to translate." },
      { id: 2, html: "This second visible comment also has enough text to translate." },
    ], settings, new AbortController().signal, "prefetch");
    expect(outputs.map((output) => output.id)).toEqual([1, 2]);
    expect(http.aiAttempts).toBe(2);
    const retryBodies = http.bodies.slice(1).map((body) => JSON.parse(body) as { readonly input?: readonly { readonly content?: string }[] });
    expect(retryBodies).toHaveLength(1);
    expect(retryBodies.every((body) => {
      const entries = JSON.parse(body.input?.at(-1)?.content ?? "[]") as { readonly id?: string }[];
      return entries.length === 2 && entries.map((entry) => entry.id).join(",") === "section_0,section_1";
    })).toBe(true);
    tasks.destroy();
  });

  it("replaces a permanently failed paragraph skeleton with an explicit retry state", async () => {
    const http = new FailingAiHttp();
    const tasks = new TranslationTaskManager();
    const service = new TranslationService(document, http, tasks, new CacheRepository(new MemoryCacheStore()), new AiCompletionClient(http));
    const settings = { ...DEFAULT_SETTINGS, translationProvider: "ai" as const, ai: { ...DEFAULT_SETTINGS.ai, apiKey: "test-key" } };
    const rendered: TranslationOutput[] = [];

    await expect(service.translateMany([{
      id: 303,
      html: "This meaningful paragraph must never leave a dead translation placeholder behind after a permanent failure.",
    }], settings, new AbortController().signal, "visible", undefined, (output) => rendered.push(output)))
      .rejects.toThrow("HTTP 502");

    expect(http.calls).toHaveLength(2);
    expect(rendered.at(-1)?.html).toContain("hnr-translation-failure");
    expect(rendered.at(-1)?.html).not.toContain("hnr-translation-placeholder");
    tasks.destroy();
  });

  it("runs public paragraphs in parallel and publishes each completed paragraph immediately", async () => {
    const http = new ParallelTranslationHttp();
    const tasks = new TranslationTaskManager();
    const service = new TranslationService(document, http, tasks, new CacheRepository(new MemoryCacheStore()), new AiCompletionClient(http));
    const settings = { ...DEFAULT_SETTINGS, translationProvider: "google" as const };
    const rendered: number[] = [];
    let settled = false;
    const source = "This visible comment has enough text to form its own translation batch. ".repeat(50);
    const pending = service.translateMany([
      { id: 1, html: `First batch. ${source}` },
      { id: 2, html: `Second batch. ${source}` },
    ], settings, new AbortController().signal, "prefetch", undefined, (output) => {
      if (output.complete) rendered.push(output.id);
    })
      .finally(() => { settled = true; });
    await vi.waitFor(() => {
      expect(http.googleAttempts).toBe(2);
      expect(rendered).toEqual([2]);
      expect(http.releaseFirst).toBeTypeOf("function");
    });
    expect(settled).toBe(false);
    http.releaseFirst?.();
    await expect(pending).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 1 }),
      expect.objectContaining({ id: 2 }),
    ]));
    expect(rendered).toEqual([2, 1]);
    tasks.destroy();
  });

  it("prefers Microsoft for a long public batch", async () => {
    const http = new TranslationHttp();
    const tasks = new TranslationTaskManager();
    const service = new TranslationService(document, http, tasks, new CacheRepository(new MemoryCacheStore()), new AiCompletionClient(http));
    const source = "This is a long paragraph with many words and punctuation. ".repeat(60);
    const outputs = await service.translateMany([{ id: 1, html: source }], DEFAULT_SETTINGS, new AbortController().signal);
    expect(outputs[0]?.provider).toBe("microsoft");
    expect(http.calls[0]).toContain("translate/auth");
    tasks.destroy();
  });

  it("never falls through public failures into a hidden AI request", async () => {
    const http = new TranslationHttp(true, true);
    const tasks = new TranslationTaskManager();
    const service = new TranslationService(document, http, tasks, new CacheRepository(new MemoryCacheStore()), new AiCompletionClient(http));
    await expect(service.translateMany([{ id: 1, html: "Please translate this complete sentence." }], DEFAULT_SETTINGS, new AbortController().signal))
      .rejects.toThrow("microsoft down");
    expect(http.calls.some((url) => url.includes("chat/completions") || url.endsWith("/responses"))).toBe(false);
    tasks.destroy();
  });
});
