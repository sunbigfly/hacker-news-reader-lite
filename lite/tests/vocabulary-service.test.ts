import { describe, expect, it, vi } from "vitest";
import type { AiMessage } from "../src/ai/ai-completion-client";
import { CacheRepository } from "../src/cache/cache-repository";
import { MemoryCacheStore } from "../src/cache/cache-store";
import { DEFAULT_SETTINGS, type ReaderSettings } from "../src/settings/settings-store";
import { TranslationTaskManager } from "../src/translation/translation-task-manager";
import { VocabularyService, type VocabularyCacheEntry } from "../src/vocabulary/service";

const SOURCE = "Late changes undermine a careful plan, even when the compiler is happy with them.";

const ANSWER = JSON.stringify([{
  word: "undermine",
  ipa: "/ˌʌndərˈmaɪn/",
  meaning: "削弱",
  example: "Late changes can undermine a careful plan.",
  exampleMeaning: "后期的改动可能削弱周密的计划。",
  level: "CET6",
}]);

function settings(overrides: Partial<ReaderSettings> = {}): ReaderSettings {
  return { ...DEFAULT_SETTINGS, vocabularyEnabled: true, ...overrides };
}

interface CapturedCall {
  readonly profile: unknown;
  readonly operation: string;
  readonly messages: readonly AiMessage[];
}

function harness(answer: string | Error = ANSWER) {
  const calls: CapturedCall[] = [];
  const complete = vi.fn((profile: unknown, operation: string, messages: readonly AiMessage[]) => {
    calls.push({ profile, operation, messages });
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  });
  const cache = new CacheRepository<VocabularyCacheEntry>(new MemoryCacheStore(), () => 1_000);
  const tasks = new TranslationTaskManager({ maxConcurrent: 4 });
  let current = settings();
  const service = new VocabularyService({
    cache,
    tasks,
    ai: { complete },
    aiProfile: () => current.ai,
    levels: () => current.vocabularyLevels,
  });
  return {
    service,
    calls,
    callCount: () => complete.mock.calls.length,
    cache,
    tasks,
    setSettings: (next: ReaderSettings) => { current = next; },
  };
}

describe("vocabulary service", () => {
  it("collects words for a comment and reports the operation and payload", async () => {
    const { service, calls, callCount } = harness();
    const words = await service.collect(SOURCE);
    expect(words.map((word) => word.word)).toEqual(["undermine"]);
    expect(callCount()).toBe(1);
    const { profile, operation, messages } = calls[0] ?? { profile: undefined, operation: "", messages: [] };
    expect(operation).toBe("vocabulary:reading");
    expect(profile).toBe(DEFAULT_SETTINGS.ai);
    expect(messages?.[0]?.role).toBe("system");
    expect(messages?.[0]?.content).toContain("六级");
    expect(JSON.parse(String(messages?.[1]?.content))).toEqual({ text: SOURCE });
  });

  it("serves a repeated comment from cache without another AI request", async () => {
    const { service, callCount } = harness();
    await service.collect(SOURCE);
    const again = await service.collect(SOURCE);
    expect(again.map((word) => word.word)).toEqual(["undermine"]);
    expect(callCount()).toBe(1);
  });

  it("deduplicates concurrent requests for the same comment", async () => {
    const { service, callCount } = harness();
    const [first, second] = await Promise.all([service.collect(SOURCE), service.collect(SOURCE)]);
    expect(first).toEqual(second);
    expect(callCount()).toBe(1);
  });

  it("requests the comment once when the cache is cold and tolerates an empty answer", async () => {
    const { service, callCount } = harness("[]");
    expect(await service.collect(SOURCE)).toEqual([]);
    expect(await service.collect(SOURCE)).toEqual([]);
    expect(callCount()).toBe(1);
  });

  it("accepts a fenced JSON answer and rejects an unparsable one", async () => {
    const fenced = harness(`\`\`\`json\n${ANSWER}\n\`\`\``);
    expect((await fenced.service.collect(SOURCE)).map((word) => word.word)).toEqual(["undermine"]);

    const broken = harness("not json at all");
    await expect(broken.service.collect(SOURCE)).rejects.toThrow(/词汇响应格式错误/u);
    await expect(broken.service.collect(SOURCE)).rejects.toThrow(/词汇响应格式错误/u);
    expect(broken.callCount()).toBe(2);
  });

  it("caches per level choice so switching difficulty asks again", async () => {
    const { service, callCount, setSettings } = harness();
    await service.collect(SOURCE);
    setSettings(settings({ vocabularyLevels: "cet6+" }));
    await service.collect(SOURCE);
    expect(callCount()).toBe(2);
  });

  it("surfaces the AI configuration error instead of a word list", async () => {
    const { service } = harness(new Error("请先配置 AI API Key 与模型"));
    await expect(service.collect(SOURCE)).rejects.toThrow(/API Key/u);
  });

  it("skips the request for a comment with no source text", async () => {
    const { service, callCount } = harness();
    expect(await service.collect("   ")).toEqual([]);
    expect(callCount()).toBe(0);
  });
});
