import type { AiCompletionClient, AiMessage } from "../ai/ai-completion-client";
import type { CacheRepository } from "../cache/cache-repository";
import { DEFAULT_CACHE_TTL_MS } from "../cache/cache-repository";
import { hashText } from "../kernel/hash";
import { normalizeAiBaseUrl, type AiProfile } from "../settings/settings-store";
import type { TranslationTaskManager, TranslationTaskPriority } from "../translation/translation-task-manager";
import { normalizeVocabularyWords, vocabularySourceText, type VocabularyWord } from "./model";
import { vocabularyPrompt, VOCABULARY_PROMPT_VERSION, type VocabularyLevelChoice } from "./prompt";

export interface VocabularyCacheEntry {
  readonly words: readonly VocabularyWord[];
}

export interface VocabularyServiceOptions {
  readonly cache: CacheRepository<VocabularyCacheEntry>;
  readonly tasks: TranslationTaskManager;
  readonly ai: Pick<AiCompletionClient, "complete">;
  readonly aiProfile: () => AiProfile;
  readonly levels: () => VocabularyLevelChoice;
}

export interface VocabularyRequestOptions {
  readonly priority?: TranslationTaskPriority;
  readonly onQueued?: () => void;
}

const EMPTY_RESULT_TTL_MS = 60_000;
const VOCABULARY_OPERATION = "vocabulary:reading";
const JSON_FENCE_PATTERN = /^```(?:json)?\s*|\s*```$/gu;

function parseAnswer(answer: string): unknown {
  const source = answer.trim().replace(JSON_FENCE_PATTERN, "");
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error("词汇响应格式错误");
  }
}

/** Tolerates the common wrapper shape while a bare array stays the documented contract. */
function answerEntries(decoded: unknown): readonly unknown[] {
  if (Array.isArray(decoded)) return decoded;
  if (decoded && typeof decoded === "object") {
    const words = (decoded as { readonly words?: unknown }).words;
    if (Array.isArray(words)) return words;
  }
  return Object.freeze([]);
}

function vocabularyMessages(source: string, levels: VocabularyLevelChoice): readonly AiMessage[] {
  return Object.freeze([
    Object.freeze({ role: "system" as const, content: vocabularyPrompt(levels) }),
    Object.freeze({ role: "user" as const, content: JSON.stringify({ text: source }) }),
  ]);
}

/**
 * Owns comment vocabulary: at most one AI request per comment body, a shared cache keyed by
 * prompt version, level choice and model, and task keys that let the Reader promote a queued
 * job when the comment reaches the viewport. Nothing here touches the DOM.
 */
export class VocabularyService {
  readonly #cache: CacheRepository<VocabularyCacheEntry>;
  readonly #tasks: TranslationTaskManager;
  readonly #ai: Pick<AiCompletionClient, "complete">;
  readonly #profile: () => AiProfile;
  readonly #levels: () => VocabularyLevelChoice;
  readonly #inflight = new Map<string, Promise<readonly VocabularyWord[]>>();

  constructor(options: VocabularyServiceOptions) {
    this.#cache = options.cache;
    this.#tasks = options.tasks;
    this.#ai = options.ai;
    this.#profile = options.aiProfile;
    this.#levels = options.levels;
  }

  cacheKey(source: string): string {
    const profile = this.#profile();
    const signature = [
      VOCABULARY_PROMPT_VERSION,
      this.#levels(),
      normalizeAiBaseUrl(profile.baseUrl),
      profile.model,
    ].join("|");
    return `vocabulary:v1:${hashText(`${signature}|${vocabularySourceText(source)}`)}`;
  }

  /** Returns the cached answer without ever starting a request. */
  async peek(source: string): Promise<readonly VocabularyWord[] | undefined> {
    if (!vocabularySourceText(source)) return Object.freeze([]);
    return (await this.#cache.get(this.cacheKey(source)))?.words;
  }

  async collect(source: string, options: VocabularyRequestOptions = {}): Promise<readonly VocabularyWord[]> {
    const text = vocabularySourceText(source);
    if (!text) return Object.freeze([]);
    const key = this.cacheKey(source);
    const cached = await this.#cache.get(key);
    if (cached) return cached.words;
    const existing = this.#inflight.get(key);
    if (existing) {
      if (options.priority) this.#tasks.promote(key, options.priority === "prefetch" ? "visible" : options.priority);
      return existing;
    }
    const pending = this.#fetch(key, text, options).finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, pending);
    return pending;
  }

  async #fetch(key: string, text: string, options: VocabularyRequestOptions): Promise<readonly VocabularyWord[]> {
    const profile = this.#profile();
    const messages = vocabularyMessages(text, this.#levels());
    const words = await this.#tasks.request({
      key,
      serviceKey: `ai:${normalizeAiBaseUrl(profile.baseUrl)}:${profile.model}`,
      priority: options.priority ?? "visible",
      // The shared queue outlives any single Reader session, so the request carries its own signal.
      signal: new AbortController().signal,
      quota: { requestsPerMinute: profile.requestsPerMinute, tokensPerMinute: profile.tokensPerMinute },
      estimatedTokens: Math.ceil((text.length + (messages[0]?.content.length ?? 0)) * 1.5),
    }, async (signal) => {
      options.onQueued?.();
      const answer = await this.#ai.complete(profile, VOCABULARY_OPERATION, messages, signal);
      signal.throwIfAborted();
      return normalizeVocabularyWords(answerEntries(parseAnswer(answer)), text);
    });
    await this.#cache.set(key, Object.freeze({ words }), words.length ? DEFAULT_CACHE_TTL_MS : EMPTY_RESULT_TTL_MS);
    return words;
  }
}
