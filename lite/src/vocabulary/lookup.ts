import { hashText } from "../kernel/hash";
import type { HttpClient, RequestDescriptor } from "../network/request-contract";

export interface DictionaryDefinition {
  readonly definition: string;
  readonly example: string;
}

export interface DictionarySense {
  readonly partOfSpeech: string;
  readonly definitions: readonly DictionaryDefinition[];
}

export interface DictionaryEntry {
  readonly meanings: readonly DictionarySense[];
  readonly sourceUrl: string;
}

export interface BilingualExample {
  readonly id: number;
  readonly english: string;
  readonly chinese: string;
  readonly translationId: number;
  readonly owner: string;
  readonly translationOwner: string;
  readonly license: string;
  readonly translationLicense: string;
}

export interface WordLookupResult<T> {
  readonly value: T;
  readonly cached: boolean;
}

const LOOKUP_TIMEOUT_MS = 8_000;
const TATOEBA_EMPTY_TTL_MS = 24 * 60 * 60 * 1_000;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function plainText(value: unknown): string {
  const template = document.createElement("template");
  template.innerHTML = text(value);
  return template.content.textContent?.trim() ?? "";
}

function dictionaryDescriptor(word: string): RequestDescriptor<readonly DictionarySense[]> {
  const url = `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`;
  return {
    key: `wordbook:wiktionary:${hashText(url)}`,
    lane: "translation",
    method: "GET",
    url,
    timeoutMs: LOOKUP_TIMEOUT_MS,
    anonymous: true,
    parallel: true,
    decode: (response) => {
      const payload = record(JSON.parse(response.body) as unknown);
      const senses = array(payload.en).flatMap((value) => {
        const sense = record(value);
        const definitions = array(sense.definitions).slice(0, 20).flatMap((value) => {
          const definition = record(value);
          const examples = array(definition.parsedExamples)
            .map((item) => plainText(record(item).example))
            .filter(Boolean);
          const plain = array(definition.examples).slice(0, 3).map(plainText).filter(Boolean);
          const body = plainText(definition.definition);
          return body ? [{ definition: body, example: examples.slice(0, 3).join("\n") || plain.join("\n") }] : [];
        });
        return definitions.length > 0
          ? [{ partOfSpeech: text(sense.partOfSpeech), definitions: Object.freeze(definitions) }]
          : [];
      });
      if (senses.length === 0) throw new Error("Wiktionary 暂未收录该词");
      return Object.freeze(senses);
    },
  };
}

function tatoebaDescriptor(word: string): RequestDescriptor<readonly BilingualExample[]> {
  const url = new URL("https://api.tatoeba.org/v1/sentences");
  const query: Readonly<Record<string, string>> = {
    sort: "relevance",
    lang: "eng",
    q: `"${word}"`,
    "trans:lang": "cmn",
    "trans:is_direct": "yes",
    "trans:is_unapproved": "no",
    "trans:is_orphan": "no",
    is_unapproved: "no",
    is_orphan: "no",
    showtrans: "matching",
    limit: "10",
  };
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return {
    key: `wordbook:tatoeba:${hashText(url.href)}`,
    lane: "translation",
    method: "GET",
    url: url.href,
    timeoutMs: LOOKUP_TIMEOUT_MS,
    anonymous: true,
    parallel: true,
    decode: (response) => {
      const payload = record(JSON.parse(response.body) as unknown);
      if (!Array.isArray(payload.data)) throw new Error("Tatoeba 例句响应格式错误");
      return Object.freeze(array(payload.data).flatMap((value) => {
        const sentence = record(value);
        const translation = array(sentence.translations)
          .map(record)
          .find((item) => item.lang === "cmn" && text(item.text));
        if (!translation || typeof sentence.id !== "number" || typeof translation.id !== "number" || !text(sentence.text)) return [];
        return [{
          id: sentence.id,
          english: text(sentence.text),
          chinese: text(translation.text),
          translationId: translation.id,
          owner: text(sentence.owner),
          translationOwner: text(translation.owner),
          license: text(sentence.license),
          translationLicense: text(translation.license),
        }];
      }).sort((left, right) => left.english.length - right.english.length).slice(0, 3));
    },
  };
}

/**
 * Owns the two public dictionary lookups the wordbook detail page uses. It never fetches on its own:
 * a request happens only when the reader opens a specific word, and the answer is kept in memory for
 * the session so reopening the same word is instant.
 */
export class WordLookupService {
  readonly #memory = new Map<string, unknown>();
  readonly #emptyAt = new Map<string, number>();

  constructor(readonly http: HttpClient) {}

  loadDictionary(word: string, signal: AbortSignal): Promise<WordLookupResult<readonly DictionarySense[]>> {
    return this.#load(`dictionary:${word.toLowerCase()}`, signal, (requestSignal) => this.#request(dictionaryDescriptor(word), requestSignal));
  }

  loadExamples(word: string, signal: AbortSignal): Promise<WordLookupResult<readonly BilingualExample[]>> {
    return this.#load(`examples:${word.toLowerCase()}`, signal, (requestSignal) => this.#request(tatoebaDescriptor(word), requestSignal));
  }

  /** An empty result is remembered briefly: the word may simply have no example yet. */
  async #load<T>(
    key: string,
    signal: AbortSignal,
    load: (requestSignal: AbortSignal) => Promise<T>,
  ): Promise<WordLookupResult<T>> {
    // A detail page that was already closed must not open a socket just to throw the answer away.
    signal.throwIfAborted();
    if (this.#memory.has(key)) return { value: this.#memory.get(key) as T, cached: true };
    const emptyAt = this.#emptyAt.get(key);
    if (emptyAt !== undefined && emptyAt > Date.now()) {
      const value = this.#memory.get(key);
      if (value !== undefined) return { value: value as T, cached: true };
    }
    const value = await load(signal);
    signal.throwIfAborted();
    this.#memory.set(key, value);
    if ((Array.isArray(value) && value.length === 0) || value == null) this.#emptyAt.set(key, Date.now() + TATOEBA_EMPTY_TTL_MS);
    else this.#emptyAt.delete(key);
    return { value, cached: false };
  }

  async #request<T>(descriptor: RequestDescriptor<T>, signal: AbortSignal): Promise<T> {
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    // Each provider gets its own bound, so a slow dictionary cannot hold the detail page open.
    const timer = setTimeout(() => controller.abort(new Error("词典请求超时，请重试")), LOOKUP_TIMEOUT_MS);
    try {
      return await this.http.request(descriptor, controller.signal);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
}
