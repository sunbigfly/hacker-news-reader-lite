import { hashText } from "../kernel/hash";
import type { HttpClient, RequestDescriptor } from "../network/request-contract";
import { normalizeAiBaseUrl, type AiProfile } from "../settings/settings-store";

export interface AiMessage { readonly role: "system" | "user"; readonly content: string }

const TRANSLATION_TIMEOUT_MS = 60_000;

function chatEndpoint(profile: AiProfile): string {
  return `${normalizeAiBaseUrl(profile.baseUrl)}/chat/completions`;
}

function responsesEndpoint(profile: AiProfile): string {
  return `${normalizeAiBaseUrl(profile.baseUrl)}/responses`;
}

function modelsEndpoint(profile: AiProfile): string {
  return `${normalizeAiBaseUrl(profile.baseUrl)}/models`;
}

function decodeCompletion(body: string): string {
  const payload = JSON.parse(body) as { readonly choices?: readonly { readonly message?: { readonly content?: unknown } }[] };
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("AI 未返回文本结果");
  return content.trim();
}

interface ResponseOutput {
  readonly output?: readonly {
    readonly type?: unknown;
    readonly content?: readonly { readonly type?: unknown; readonly text?: unknown }[];
  }[];
  readonly error?: { readonly message?: unknown } | null;
}

function decodeResponseOutput(payload: ResponseOutput): string {
  const content = (payload.output ?? []).flatMap((item) => item.type === "message"
    ? (item.content ?? []).flatMap((part) => part.type === "output_text" && typeof part.text === "string" ? [part.text] : [])
    : []).join("");
  if (!content.trim()) {
    const message = payload.error?.message;
    throw new Error(typeof message === "string" && message.trim() ? message : "AI 未返回文本结果");
  }
  return content.trim();
}

function decodeResponse(body: string): string {
  return decodeResponseOutput(JSON.parse(body) as ResponseOutput);
}

function translationJsonComplete(content: string): boolean {
  const source = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!source.startsWith("{") || !source.endsWith("}")) return false;
  try {
    const value: unknown = JSON.parse(source);
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  } catch {
    return false;
  }
}

class ChatCompletionStreamDecoder {
  #received = "";
  #pending = "";
  #content = "";

  constructor(readonly onContent?: (content: string) => void) {}

  push(body: string, final = false): string {
    const chunk = body.startsWith(this.#received) ? body.slice(this.#received.length) : body;
    this.#received = body.startsWith(this.#received) ? body : this.#received + body;
    this.#pending += chunk;
    for (;;) {
      const separator = /\r?\n\r?\n/.exec(this.#pending);
      if (!separator || separator.index === undefined) break;
      const event = this.#pending.slice(0, separator.index);
      this.#pending = this.#pending.slice(separator.index + separator[0].length);
      this.#consumeEvent(event);
    }
    if (final && this.#pending.trim()) {
      this.#consumeEvent(this.#pending);
      this.#pending = "";
    }
    return this.#content;
  }

  #consumeEvent(event: string): void {
    for (const line of event.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      const payload = JSON.parse(data) as { readonly choices?: readonly { readonly delta?: { readonly content?: unknown } }[] };
      const delta = payload.choices?.[0]?.delta?.content;
      if (typeof delta !== "string" || !delta) continue;
      this.#content += delta;
      this.onContent?.(this.#content);
    }
  }
}

class ResponseStreamDecoder {
  #received = "";
  #pending = "";
  #content = "";
  #failure: Error | undefined;
  #done = false;

  constructor(readonly onContent?: (content: string) => void) {}

  get done(): boolean { return this.#done; }

  push(body: string, final = false): string {
    const chunk = body.startsWith(this.#received) ? body.slice(this.#received.length) : body;
    this.#received = body.startsWith(this.#received) ? body : this.#received + body;
    this.#pending += chunk;
    for (;;) {
      const separator = /\r?\n\r?\n/.exec(this.#pending);
      if (!separator || separator.index === undefined) break;
      const event = this.#pending.slice(0, separator.index);
      this.#pending = this.#pending.slice(separator.index + separator[0].length);
      this.#consumeEvent(event);
    }
    if (final && this.#pending.trim()) {
      this.#consumeEvent(this.#pending);
      this.#pending = "";
    }
    if (final && this.#failure) throw this.#failure;
    return this.#content;
  }

  #publish(content: string): void {
    if (!content || content === this.#content) return;
    this.#content = content;
    this.onContent?.(content);
  }

  #consumeEvent(event: string): void {
    for (const line of event.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === "[DONE]") {
        this.#done = true;
        continue;
      }
      const payload = JSON.parse(data) as {
        readonly type?: unknown;
        readonly delta?: unknown;
        readonly text?: unknown;
        readonly response?: ResponseOutput;
      };
      if (payload.type === "response.output_text.delta" && typeof payload.delta === "string") {
        this.#publish(this.#content + payload.delta);
      } else if (payload.type === "response.output_text.done" && typeof payload.text === "string") {
        this.#publish(payload.text);
      } else if (payload.type === "response.completed" && payload.response && !this.#content) {
        this.#publish(decodeResponseOutput(payload.response));
      } else if (payload.type === "response.failed") {
        const message = payload.response?.error?.message;
        this.#failure = new Error(typeof message === "string" && message.trim() ? message : "AI 响应失败");
      }
      if (payload.type === "response.completed" || payload.type === "response.failed") this.#done = true;
    }
  }
}

export class AiCompletionClient {
  constructor(readonly http: HttpClient) {}

  complete(
    profile: AiProfile,
    operation: string,
    messages: readonly AiMessage[],
    signal?: AbortSignal,
    onContent?: (content: string) => void,
  ): Promise<string> {
    if (!profile.apiKey.trim() || !profile.model.trim()) return Promise.reject(new Error("请先配置 AI API Key 与模型"));
    if (operation.startsWith("translation:")) return this.#completeTranslation(profile, operation, messages, signal, onContent);
    const body = JSON.stringify({
      model: profile.model.trim(),
      messages,
      temperature: 0.2,
      stream: false,
    });
    const stream = new ChatCompletionStreamDecoder(onContent);
    const descriptor: RequestDescriptor<string> = {
      key: `ai:${operation}:${hashText(`${profile.baseUrl}|${profile.model}|${body}`)}`,
      lane: "ai",
      method: "POST",
      url: chatEndpoint(profile),
      headers: {
        Accept: "text/event-stream, application/json",
        Authorization: `Bearer ${profile.apiKey.trim()}`,
        "Content-Type": "application/json",
      },
      body,
      timeoutMs: 90_000,
      anonymous: true,
      stream: false,
      onProgress: (response) => { stream.push(response.body); },
      decode: (response) => stream.push(response.body, true).trim() || decodeCompletion(response.body),
    };
    return this.http.request(descriptor, signal);
  }

  #completeTranslation(
    profile: AiProfile,
    operation: string,
    messages: readonly AiMessage[],
    signal?: AbortSignal,
    onContent?: (content: string) => void,
  ): Promise<string> {
    const body = JSON.stringify({
      model: profile.model.trim(),
      input: messages,
      reasoning: { effort: "low" },
      stream: true,
      store: false,
    });
    const stream = new ResponseStreamDecoder(onContent);
    const descriptor: RequestDescriptor<string> = {
      key: `ai:${operation}:${hashText(`${profile.baseUrl}|${profile.model}|${body}`)}`,
      lane: "ai",
      method: "POST",
      url: responsesEndpoint(profile),
      headers: {
        Accept: "text/event-stream, application/json",
        Authorization: `Bearer ${profile.apiKey.trim()}`,
        "Content-Type": "application/json",
      },
      body,
      timeoutMs: TRANSLATION_TIMEOUT_MS,
      anonymous: true,
      parallel: true,
      stream: true,
      onProgress: (response) => {
        const content = stream.push(response.body);
        return stream.done || translationJsonComplete(content);
      },
      decode: (response) => stream.push(response.body, true).trim() || decodeResponse(response.body),
    };
    return this.http.request(descriptor, signal);
  }

  listModels(profile: AiProfile, signal?: AbortSignal): Promise<readonly string[]> {
    const descriptor: RequestDescriptor<readonly string[]> = {
      key: `ai:models:${hashText(profile.baseUrl)}`,
      lane: "ai",
      method: "GET",
      url: modelsEndpoint(profile),
      headers: {
        Accept: "application/json",
        ...(profile.apiKey.trim() ? { Authorization: `Bearer ${profile.apiKey.trim()}` } : {}),
      },
      timeoutMs: 8_000,
      anonymous: true,
      parallel: true,
      decode: (response) => {
        const payload = JSON.parse(response.body) as { readonly data?: readonly { readonly id?: unknown }[] };
        const models = [...new Set((payload.data ?? []).flatMap((item) => typeof item.id === "string" && item.id.trim() ? [item.id.trim()] : []))];
        if (models.length === 0) throw new Error("/models 未返回可用模型");
        return Object.freeze(models.slice(0, 500));
      },
    };
    return this.http.request(descriptor, signal);
  }
}
