import type { CacheRepository } from "../cache/cache-repository";
import { hashText } from "../kernel/hash";
import { RequestError, type HttpClient, type RequestDescriptor } from "../network/request-contract";
import type { AiCompletionClient } from "../ai/ai-completion-client";
import type { ReaderSettings } from "../settings/settings-store";
import { sanitizeHtml } from "../security/sanitize-html";
import {
  renderBilingualSections,
  renderTranslationSections,
  translationBlockNeedsTranslation,
  translationProtectedTokensMatch,
  translationSectionPlans,
  translationTextFingerprint,
} from "./translation-text";
import { TranslationTaskManager, type TranslationTaskPriority } from "./translation-task-manager";

export interface TranslationInput {
  readonly id: number;
  readonly html: string;
  readonly preheatedSource?: string;
  readonly translateShortText?: boolean;
  readonly forceRefresh?: boolean;
}
export interface TranslationOutput {
  readonly id: number;
  readonly text: string;
  readonly html: string;
  readonly bilingualHtml: string;
  readonly provider: "google" | "microsoft" | "ai";
  readonly complete: boolean;
}
export interface CachedTranslation { readonly translation: string; readonly sections?: readonly string[]; readonly provider: TranslationOutput["provider"] }
interface PreparedSection {
  readonly index: number;
  readonly requestSource: string;
}
interface PreparedTranslation {
  readonly input: TranslationInput;
  readonly wrapper: HTMLDivElement;
  readonly sections: readonly PreparedSection[];
  readonly fingerprint: string;
  readonly cacheKey: string;
}
interface PreparedBatchEntry {
  readonly item: PreparedTranslation;
  readonly section: PreparedSection;
}
interface TranslationBatchResult {
  readonly values: readonly string[];
  readonly provider: TranslationOutput["provider"];
}
interface AiTranslationSource {
  readonly before: string;
  readonly text: string;
  readonly after: string;
}
interface StreamedJsonValue {
  readonly value: string;
  readonly complete: boolean;
}
interface TranslationSectionState {
  readonly translations: Map<number, string>;
  readonly completed: Set<number>;
  readonly failed: Set<number>;
  readonly providers: Map<number, TranslationOutput["provider"]>;
  readonly partialSignatures: Map<number, string>;
  published: boolean;
  persisting: Promise<void> | null;
}

const CONTEXT_START = "⟦900000⟧";
const CONTEXT_END = "⟦900001⟧";
const TOKEN_PATTERN = /⟦\d+⟧/g;
const TRANSLATION_BATCH_MAX_SECTIONS = 6;
const TRANSLATION_BATCH_MAX_CHARS = 8_000;
const PUBLIC_TRANSLATION_BATCH_MAX_CHARS = 2_800;
const AI_EXCERPT_MIN_CHARS = 80;
const AI_EXCERPT_MIN_ADDITIONAL_CHARS = 32;
const FORMATTED_PROTECTED_TOKEN_PATTERN = /⟦([\d\p{Cf}\p{White_Space}]+)⟧/gu;
const PROTECTED_TOKEN_IGNORABLE_PATTERN = /[\p{Cf}\p{White_Space}]/gu;

function normalizeProtectedTokenFormatting(value: string): string {
  return value.replace(FORMATTED_PROTECTED_TOKEN_PATTERN, (token, body: string) => {
    const digits = body.replace(PROTECTED_TOKEN_IGNORABLE_PATTERN, "");
    return /^\d+$/.test(digits) ? `⟦${digits}⟧` : token;
  });
}

function contextText(value: string, edge: "start" | "end"): string {
  const plain = value.replace(TOKEN_PATTERN, "").replace(/\s+/g, " ").trim();
  return edge === "start" ? plain.slice(0, 320) : plain.slice(-320);
}

function withSectionContext(sources: readonly string[], index: number): string {
  const before = index > 0 ? contextText(sources[index - 1] ?? "", "end") : "";
  const after = index + 1 < sources.length ? contextText(sources[index + 1] ?? "", "start") : "";
  if (!before && !after) return sources[index] ?? "";
  return `${before}\n${CONTEXT_START}${sources[index] ?? ""}${CONTEXT_END}\n${after}`;
}

function aiTranslationSource(source: string): AiTranslationSource {
  const start = source.indexOf(CONTEXT_START);
  if (start < 0) return Object.freeze({ before: "", text: source, after: "" });
  const end = source.indexOf(CONTEXT_END, start + CONTEXT_START.length);
  if (end < 0) throw new Error("翻译 section 缺少上下文结束边界");
  return Object.freeze({
    before: source.slice(0, start).trim(),
    text: source.slice(start + CONTEXT_START.length, end),
    after: source.slice(end + CONTEXT_END.length).trim(),
  });
}

function extractSectionTranslation(source: string, translated: string): string {
  if (!source.includes(CONTEXT_START)) return translated.trim();
  const start = translated.indexOf(CONTEXT_START);
  const end = translated.indexOf(CONTEXT_END, start + CONTEXT_START.length);
  if (start < 0 || end < 0 || end <= start) throw new Error("翻译服务未保留 section 上下文边界");
  return translated.slice(start + CONTEXT_START.length, end).trim();
}

function validatedResults(values: readonly string[], sources: readonly string[], provider: string): readonly string[] {
  const normalized = values.map(normalizeProtectedTokenFormatting);
  if (normalized.length !== sources.length || normalized.some((value, index) => !value.trim() || !translationProtectedTokensMatch(sources[index] ?? "", value))) {
    throw new Error(`${provider} 返回的译文不完整或改写了正文占位符`);
  }
  return Object.freeze(normalized.map((value) => value.trim()));
}

function parseJsonRecord(raw: string): Readonly<Record<string, string>> {
  const source = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const payload = JSON.parse(source) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("AI 译文必须是 JSON 对象");
  return Object.freeze(Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, typeof value === "string" ? value : ""])));
}

function streamedJsonString(source: string, start: number, allowPartial = false): { readonly value: string; readonly next: number; readonly complete: boolean } | null {
  if (source[start] !== "\"") return null;
  let value = "";
  let cursor = start + 1;
  while (cursor < source.length) {
    const character = source[cursor] ?? "";
    if (character === "\"") return { value, next: cursor + 1, complete: true };
    if (character === "\\") {
      const escape = source[cursor + 1];
      if (!escape) return allowPartial ? { value, next: source.length, complete: false } : null;
      if (escape === "u") {
        const code = source.slice(cursor + 2, cursor + 6);
        if (code.length < 4) return allowPartial ? { value, next: source.length, complete: false } : null;
        if (!/^[\da-f]{4}$/i.test(code)) return null;
        value += String.fromCharCode(Number.parseInt(code, 16));
        cursor += 6;
        continue;
      }
      const escaped = ({ "\"": "\"", "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" } as const)[escape as "\"" | "\\" | "/" | "b" | "f" | "n" | "r" | "t"];
      if (escaped === undefined) return null;
      value += escaped;
      cursor += 2;
      continue;
    }
    if (character.charCodeAt(0) < 0x20) return null;
    value += character;
    cursor += 1;
  }
  return allowPartial ? { value, next: source.length, complete: false } : null;
}

function streamedJsonRecord(raw: string): Readonly<Record<string, StreamedJsonValue>> {
  const start = raw.indexOf("{");
  if (start < 0) return Object.freeze({});
  const values: Record<string, StreamedJsonValue> = {};
  let cursor = start + 1;
  const skipWhitespace = (): void => {
    while (cursor < raw.length && /\s/.test(raw[cursor] ?? "")) cursor += 1;
  };
  for (;;) {
    skipWhitespace();
    if (raw[cursor] === ",") {
      cursor += 1;
      skipWhitespace();
    }
    if (raw[cursor] === "}" || cursor >= raw.length) break;
    const key = streamedJsonString(raw, cursor);
    if (!key) break;
    cursor = key.next;
    skipWhitespace();
    if (raw[cursor] !== ":") break;
    cursor += 1;
    skipWhitespace();
    const value = streamedJsonString(raw, cursor, true);
    if (!value) break;
    values[key.value] = Object.freeze({ value: value.value, complete: value.complete });
    cursor = value.next;
    if (!value.complete) break;
  }
  return Object.freeze(values);
}

function retryableAiTranslationError(error: unknown): boolean {
  if (error instanceof RequestError) {
    if (error.kind === "network" || error.kind === "timeout" || error.kind === "decode") return true;
    return error.kind === "http" && (error.status === 408 || error.status === 425 || error.status === 429 || (error.status !== undefined && error.status >= 500));
  }
  if (error instanceof SyntaxError) return true;
  const message = error instanceof Error ? error.message : "";
  return message.startsWith("AI 译文") || message.startsWith("AI 返回的译文") || message.startsWith("AI 重试译文");
}

function comparableAiSectionSource(section: PreparedSection): string {
  return aiTranslationSource(section.requestSource).text
    .replace(TOKEN_PATTERN, " ")
    .replace(/(^|\n)\s*(?:>\s*)+/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

function aiExcerptConflict(left: PreparedBatchEntry, right: PreparedBatchEntry): boolean {
  if (left.item.input.id === right.item.input.id) return false;
  const leftSource = comparableAiSectionSource(left.section);
  const rightSource = comparableAiSectionSource(right.section);
  const [shorter, longer] = leftSource.length <= rightSource.length
    ? [leftSource, rightSource]
    : [rightSource, leftSource];
  return shorter.length >= AI_EXCERPT_MIN_CHARS
    && longer.length - shorter.length >= AI_EXCERPT_MIN_ADDITIONAL_CHARS
    && longer.includes(shorter);
}

function translationRequestBatches(
  items: readonly PreparedTranslation[],
  packAiSections: boolean,
): readonly (readonly PreparedBatchEntry[])[] {
  const ordered: PreparedBatchEntry[] = [];
  const maximumSections = Math.max(0, ...items.map((item) => item.sections.length));
  for (let sectionIndex = 0; sectionIndex < maximumSections; sectionIndex += 1) {
    for (const item of items) {
      const section = item.sections[sectionIndex];
      if (section) ordered.push(Object.freeze({ item, section }));
    }
  }
  const batches: PreparedBatchEntry[][] = [];
  let current: PreparedBatchEntry[] = [];
  let characters = 0;
  const maximumEntries = packAiSections ? Number.POSITIVE_INFINITY : TRANSLATION_BATCH_MAX_SECTIONS;
  const maximumCharacters = packAiSections ? TRANSLATION_BATCH_MAX_CHARS : PUBLIC_TRANSLATION_BATCH_MAX_CHARS;
  for (const entry of ordered) {
    const overlapsPackedExcerpt = packAiSections && current.some((candidate) => aiExcerptConflict(candidate, entry));
    if (
      current.length > 0
      && (
        current.length >= maximumEntries
        || characters + entry.section.requestSource.length > maximumCharacters
        || overlapsPackedExcerpt
      )
    ) {
      batches.push(current);
      current = [];
      characters = 0;
    }
    current.push(entry);
    characters += entry.section.requestSource.length;
  }
  if (current.length > 0) batches.push(current);
  return Object.freeze(batches.map((batch) => Object.freeze(batch)));
}

export class TranslationService {
  #microsoftToken: string | null = null;
  #microsoftTokenPromise: Promise<string> | null = null;
  readonly #taskKeysByInputId = new Map<number, Map<string, number>>();
  readonly #requestedPriorities = new Map<number, Exclude<TranslationTaskPriority, "prefetch">>();

  constructor(
    readonly document: Document,
    readonly http: HttpClient,
    readonly tasks: TranslationTaskManager,
    readonly cache: CacheRepository<CachedTranslation>,
    readonly ai: AiCompletionClient,
    readonly digest: SubtleCrypto = crypto.subtle,
  ) {}

  promoteInputs(
    ids: readonly number[],
    priority: Exclude<TranslationTaskPriority, "prefetch"> = "visible",
  ): number {
    let promoted = 0;
    for (const id of ids) {
      const previous = this.#requestedPriorities.get(id);
      if (previous !== "interactive") this.#requestedPriorities.set(id, priority);
      for (const key of this.#taskKeysByInputId.get(id)?.keys() ?? []) {
        if (this.tasks.promote(key, priority)) promoted += 1;
      }
    }
    return promoted;
  }

  async translateMany(
    inputs: readonly TranslationInput[],
    settings: ReaderSettings,
    signal: AbortSignal,
    priority: TranslationTaskPriority = "visible",
    onProgress?: (complete: number, total: number) => void,
    onOutput?: (output: TranslationOutput) => void,
  ): Promise<readonly TranslationOutput[]> {
    const prepared = (await Promise.all(inputs.map(async (input) => this.#prepare(input, settings)))).filter((item): item is PreparedTranslation => item !== null);
    const outputs: TranslationOutput[] = [];
    const missing: PreparedTranslation[] = [];
    const publish = (item: PreparedTranslation, cached: CachedTranslation): TranslationOutput => {
      const output = this.#render(item, cached);
      outputs.push(output);
      onOutput?.(output);
      onProgress?.(outputs.length, prepared.length);
      return output;
    };
    onProgress?.(0, prepared.length);
    const cachedItems = await Promise.all(prepared.map(async (item) => Object.freeze({
      item,
      cached: item.input.forceRefresh ? null : await this.cache.get(item.cacheKey),
    })));
    for (const { item, cached } of cachedItems) {
      if (cached) publish(item, cached);
      else missing.push(item);
    }
    const states = new Map<PreparedTranslation, TranslationSectionState>(missing.map((item) => {
      const state: TranslationSectionState = {
        translations: new Map<number, string>(),
        completed: new Set<number>(),
        failed: new Set<number>(),
        providers: new Map<number, TranslationOutput["provider"]>(),
        partialSignatures: new Map<number, string>(),
        published: false,
        persisting: null,
      };
      return [item, state];
    }));
    for (const item of missing) {
      onOutput?.(this.#renderSections(
        item,
        new Map(),
        settings.translationProvider === "ai" ? "ai" : "google",
        false,
        new Set(),
      ));
    }
    const updateSection = async (
      item: PreparedTranslation,
      section: PreparedSection,
      value: string,
      provider: TranslationOutput["provider"],
      complete: boolean,
    ): Promise<void> => {
      const state = states.get(item);
      if (!state) return;
      if (state.published) {
        await state.persisting;
        return;
      }
      const translated = value.trim();
      if (!translated) return;
      const signature = `${complete ? "1" : "0"}:${translated}`;
      if (state.partialSignatures.get(section.index) === signature) return;
      state.partialSignatures.set(section.index, signature);
      state.translations.set(section.index, translated);
      state.providers.set(section.index, provider);
      if (complete) state.completed.add(section.index);
      if (state.completed.size < item.sections.length) {
        onOutput?.(this.#renderSections(item, state.translations, provider, false, state.completed, state.failed));
        return;
      }
      state.published = true;
      const sections = item.sections.map((entry) => state.translations.get(entry.index) ?? "");
      const finalProvider = state.providers.get(item.sections.at(-1)?.index ?? section.index) ?? provider;
      const cached: CachedTranslation = {
        translation: sections.join("\n\n"),
        sections: Object.freeze(sections),
        provider: finalProvider,
      };
      publish(item, cached);
      state.persisting = this.cache.set(item.cacheKey, cached);
      await state.persisting;
    };
    const queuedBatches = translationRequestBatches(missing, settings.translationProvider === "ai");
    const sectionTasks = queuedBatches.map((entries) => async (): Promise<void> => {
      signal.throwIfAborted();
      const sources = entries.map(({ section }) => section.requestSource);
      const sectionIdentity = entries
        .map(({ item, section }) => `${item.input.id}:${item.cacheKey}:${section.index}`)
        .join("|");
      const inputIds = [...new Set(entries.map(({ item }) => item.input.id))];
      const readBatchPriority = (): TranslationTaskPriority => inputIds.reduce<TranslationTaskPriority>((current, id) => {
        const requested = this.#requestedPriorities.get(id);
        if (requested === "interactive" || current === "interactive") return "interactive";
        return requested === "visible" || current === "visible" ? "visible" : "prefetch";
      }, priority);
      const taskBase = {
        serviceKey: settings.translationProvider === "ai" ? `ai:${settings.ai.baseUrl}:${settings.ai.model}` : "public:translation",
        signal,
        ...(settings.translationProvider === "ai" ? { quota: {
          requestsPerMinute: settings.ai.requestsPerMinute,
          tokensPerMinute: settings.ai.tokensPerMinute,
        } } : {}),
        estimatedTokens: Math.ceil(sources.reduce((sum, source) => sum + source.length, 0) / 3),
      } as const;
      const publishStreamValue = (partial: Readonly<Record<string, StreamedJsonValue>>): void => {
        for (const [batchIndex, { item, section }] of entries.entries()) {
          const streamedValue = partial[`section_${batchIndex}`];
          if (!streamedValue?.value.trim()) continue;
          const validationSource = aiTranslationSource(section.requestSource).text;
          if (!streamedValue.complete) {
            if ((validationSource.match(TOKEN_PATTERN) ?? []).length > 0 && !translationProtectedTokensMatch(validationSource, streamedValue.value)) continue;
          } else {
            try {
              validatedResults([streamedValue.value], [validationSource], "AI");
            } catch {
              continue;
            }
          }
          void updateSection(item, section, streamedValue.value, "ai", streamedValue.complete);
        }
      };
      const request = async (attempt: "initial" | "retry"): Promise<TranslationBatchResult> => {
        const key = `translation:batch:${hashText(sectionIdentity)}:${attempt}`;
        for (const id of inputIds) {
          const keys = this.#taskKeysByInputId.get(id) ?? new Map<string, number>();
          keys.set(key, (keys.get(key) ?? 0) + 1);
          this.#taskKeysByInputId.set(id, keys);
        }
        try {
          return await this.tasks.request<TranslationBatchResult>({ ...taskBase, key, priority: readBatchPriority() }, async (taskSignal) => this.#translateSources(
            sources,
            settings,
            taskSignal,
            `translation:batch:${hashText(sectionIdentity)}:${attempt}`,
            publishStreamValue,
          ));
        } finally {
          for (const id of inputIds) {
            const keys = this.#taskKeysByInputId.get(id);
            const subscribers = keys?.get(key) ?? 0;
            if (subscribers <= 1) keys?.delete(key);
            else keys?.set(key, subscribers - 1);
            if (keys?.size === 0) {
              this.#taskKeysByInputId.delete(id);
              this.#requestedPriorities.delete(id);
            }
          }
        }
      };
      let result: TranslationBatchResult;
      try {
        result = await request("initial");
      } catch (error) {
        try {
          if (settings.translationProvider !== "ai" || !retryableAiTranslationError(error)) throw error;
          result = await request("retry");
        } catch (finalError) {
          for (const { item, section } of entries) {
            const state = states.get(item);
            if (!signal.aborted && state && !state.published) {
              state.failed.add(section.index);
              state.translations.delete(section.index);
              onOutput?.(this.#renderSections(
                item,
                state.translations,
                settings.translationProvider === "ai" ? "ai" : "google",
                false,
                state.completed,
                state.failed,
              ));
            }
          }
          throw finalError;
        }
      }
      for (const [batchIndex, { item, section }] of entries.entries()) {
        const translated = result.values[batchIndex];
        if (!translated) throw new Error("翻译段落未返回有效译文");
        await updateSection(item, section, translated, result.provider, true);
      }
    });
    const results = await Promise.allSettled(sectionTasks.map((task) => task()));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
    const order = new Map(inputs.map((input, index) => [input.id, index]));
    outputs.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
    return Object.freeze(outputs);
  }

  async #prepare(input: TranslationInput, settings: ReaderSettings): Promise<PreparedTranslation | null> {
    const wrapper = this.document.createElement("div");
    wrapper.innerHTML = sanitizeHtml(input.html, this.document, this.document.baseURI);
    if (
      input.preheatedSource
      && !translationBlockNeedsTranslation(input.preheatedSource, input.translateShortText)
    ) return null;
    const plans = translationSectionPlans(wrapper);
    const sources = plans.map((plan) => plan.text);
    const sections = plans
      .filter((plan) => translationBlockNeedsTranslation(plan.text, input.translateShortText))
      .map((plan) => ({ index: plan.index, requestSource: withSectionContext(sources, plan.index) }));
    if (sections.length === 0) return null;
    const fingerprint = await translationTextFingerprint(sections.map((section) => section.requestSource), this.digest);
    const aiIdentity = settings.translationProvider === "ai" ? `${settings.ai.baseUrl}|${settings.ai.model}|${settings.ai.prompt}` : "public";
    return {
      input,
      wrapper,
      sections: Object.freeze(sections),
      fingerprint,
      cacheKey: `translation:v2:${settings.translationProvider}:${settings.targetLanguage}:${hashText(aiIdentity)}:${fingerprint}`,
    };
  }

  #render(item: PreparedTranslation, cached: CachedTranslation): TranslationOutput {
    const sectionValues = cached.sections ?? (item.sections.length === 1 ? [cached.translation] : []);
    if (sectionValues.length !== item.sections.length) throw new Error("缓存译文的 section 数量不匹配");
    const translations = new Map(item.sections.map((section, index) => [section.index, sectionValues[index] ?? ""]));
    return this.#renderSections(item, translations, cached.provider, true);
  }

  #renderSections(
    item: PreparedTranslation,
    translations: ReadonlyMap<number, string>,
    provider: TranslationOutput["provider"],
    complete: boolean,
    completedSections: ReadonlySet<number> = new Set(item.sections.map((section) => section.index)),
    failedSections: ReadonlySet<number> = new Set(),
  ): TranslationOutput {
    const pending = new Set(complete
      ? []
      : item.sections.filter((section) => !completedSections.has(section.index)).map((section) => section.index));
    const streaming = new Set([...translations.keys()].filter((index) => pending.has(index) && !failedSections.has(index)));
    const visualState = complete ? undefined : { pending, streaming, failed: failedSections };
    const fragment = renderTranslationSections(item.wrapper, translations, visualState);
    if (!fragment) throw new Error("缓存译文的占位符与原文不匹配");
    const bilingualFragment = renderBilingualSections(item.wrapper, translations, visualState);
    if (!bilingualFragment) throw new Error("双语 section 无法按原文结构回填");
    const holder = this.document.createElement("div");
    holder.append(fragment);
    const bilingualHolder = this.document.createElement("div");
    bilingualHolder.append(bilingualFragment);
    return {
      id: item.input.id,
      text: holder.textContent?.trim() || [...translations.values()].join("\n\n").trim(),
      html: holder.innerHTML,
      bilingualHtml: bilingualHolder.innerHTML,
      provider,
      complete,
    };
  }

  async #translateSources(
    sources: readonly string[],
    settings: ReaderSettings,
    signal: AbortSignal,
    requestIdentity: string,
    onPartial?: (values: Readonly<Record<string, StreamedJsonValue>>) => void,
  ): Promise<TranslationBatchResult> {
    if (settings.translationProvider === "ai") {
      const entries = sources.map(aiTranslationSource);
      const keyedEntries = entries.map((entry, index) => ({ ...entry, id: `section_${index}` }));
      const raw = await this.ai.complete(settings.ai, requestIdentity, [
        { role: "system", content: `你是严格的翻译器。输入是带 id 的 JSON 对象数组；只翻译每项 text，before/after 仅用于理解相邻上下文，不得写入结果。每项 text 都是独立、完整的边界；不得把其他项的续句或相似段落补入译文。输出一个 JSON 对象，以每项 id 为键、对应简体中文译文为值；原样保留 text 中全部 ⟦数字⟧ 占位符，不得遗漏、合并或增加 id。只输出 JSON 对象。${settings.ai.prompt}` },
        { role: "user", content: JSON.stringify(keyedEntries) },
      ], signal, (content) => onPartial?.(streamedJsonRecord(content)));
      const keyedValues = parseJsonRecord(raw);
      const values = keyedEntries.map((entry) => keyedValues[entry.id] ?? "");
      return { values: validatedResults(values, entries.map((entry) => entry.text), "AI"), provider: "ai" };
    }
    const providers: readonly ("google" | "microsoft")[] = settings.translationProvider === "google"
      ? ["google"]
      : settings.translationProvider === "microsoft"
        ? ["microsoft"]
        : sources.reduce((sum, source) => sum + source.length, 0) > 2_800
          ? ["microsoft", "google"]
          : ["google", "microsoft"];
    let failure: unknown;
    for (const provider of providers) {
      try {
        const values = provider === "google"
          ? await this.#google(sources, signal, requestIdentity)
          : await this.#microsoft(sources, signal, requestIdentity);
        return { values: Object.freeze(values.map((value, index) => extractSectionTranslation(sources[index] ?? "", value))), provider };
      } catch (error) {
        failure = error;
        if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("翻译任务已取消");
      }
    }
    throw failure instanceof Error ? failure : new Error("翻译服务不可用");
  }

  async #google(sources: readonly string[], signal: AbortSignal, requestIdentity: string): Promise<readonly string[]> {
    const url = new URL("https://translate.googleapis.com/translate_a/t");
    url.searchParams.set("client", "dict-chrome-ex");
    url.searchParams.set("sl", "auto");
    url.searchParams.set("tl", "zh-CN");
    for (const source of sources) url.searchParams.append("q", source);
    if (url.href.length > 7_500 && sources.length > 1) {
      const middle = Math.ceil(sources.length / 2);
      const first = await this.#google(sources.slice(0, middle), signal, `${requestIdentity}:first`);
      const second = await this.#google(sources.slice(middle), signal, `${requestIdentity}:second`);
      return Object.freeze([...first, ...second]);
    }
    const descriptor: RequestDescriptor<readonly string[]> = {
      key: `translation:google:${requestIdentity}:${hashText(sources.join("|"))}`,
      lane: "translation",
      method: "GET",
      url: url.href,
      timeoutMs: 25_000,
      anonymous: true,
      parallel: true,
      decode: (response) => {
        const payload = JSON.parse(response.body) as unknown;
        if (!Array.isArray(payload)) throw new Error("Google 翻译响应必须是数组");
        const values = payload.map((item) => String(Array.isArray(item) ? item[0] ?? "" : ""));
        return validatedResults(values, sources, "Google");
      },
    };
    return this.http.request(descriptor, signal);
  }

  async #microsoft(sources: readonly string[], signal: AbortSignal, requestIdentity: string): Promise<readonly string[]> {
    const token = await this.#microsoftAuth(signal);
    const descriptor: RequestDescriptor<readonly string[]> = {
      key: `translation:microsoft:${requestIdentity}:${hashText(sources.join("|"))}`,
      lane: "translation",
      method: "POST",
      url: "https://api-edge.cognitive.microsofttranslator.com/translate?api-version=3.0&to=zh-Hans",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(sources.map((Text) => ({ Text }))),
      timeoutMs: 25_000,
      anonymous: true,
      parallel: true,
      decode: (response) => {
        const payload = JSON.parse(response.body) as unknown;
        if (!Array.isArray(payload)) throw new Error("Microsoft 翻译响应必须是数组");
        const values = payload.map((item) => {
          const translations: unknown = item && typeof item === "object" ? (item as { readonly translations?: unknown }).translations : null;
          const first: unknown = Array.isArray(translations) ? (translations as unknown[])[0] : null;
          if (!first || typeof first !== "object") return "";
          const translated: unknown = (first as { readonly text?: unknown }).text;
          return typeof translated === "string" ? translated : "";
        });
        return validatedResults(values, sources, "Microsoft");
      },
    };
    return this.http.request(descriptor, signal);
  }

  async #microsoftAuth(signal: AbortSignal): Promise<string> {
    if (this.#microsoftToken) return this.#microsoftToken;
    this.#microsoftTokenPromise ??= this.http.request({
      key: "translation:microsoft-auth:v1",
      lane: "translation",
      method: "GET",
      url: "https://edge.microsoft.com/translate/auth",
      timeoutMs: 15_000,
      anonymous: true,
      parallel: true,
      decode: (response) => {
        const token = response.body.trim();
        if (!token) throw new Error("Microsoft 未返回访问令牌");
        return token;
      },
    }, signal).then((token) => {
      this.#microsoftToken = token;
      return token;
    }).finally(() => { this.#microsoftTokenPromise = null; });
    return this.#microsoftTokenPromise;
  }
}
