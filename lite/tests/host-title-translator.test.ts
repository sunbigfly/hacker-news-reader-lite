// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { LifecycleScope } from "../src/kernel/lifecycle";
import {
  DEFAULT_SETTINGS,
  SettingsStore,
  type ReaderSettings,
} from "../src/settings/settings-store";
import { HostTitleTranslator } from "../src/translation/host-title-translator";
import type {
  TranslationInput,
  TranslationOutput,
} from "../src/translation/translation-service";

describe("host translation adapter", () => {
  it("translates host comments through the provider and AI profile active in settings", async () => {
    const activeSettings: ReaderSettings = {
      ...DEFAULT_SETTINGS,
      translationEnabled: true,
      translationProvider: "ai",
      ai: {
        ...DEFAULT_SETTINGS.ai,
        apiKey: "test-key",
        baseUrl: "https://translator.example/v1",
        model: "active-model",
        prompt: "active prompt",
      },
    };
    const settingsStore = new SettingsStore();
    vi.spyOn(settingsStore, "load").mockReturnValue(activeSettings);
    const output: TranslationOutput = {
      id: 49327487,
      text: "用户评论译文",
      html: "用户评论译文",
      bilingualHtml: "用户评论译文",
      provider: "ai",
      complete: true,
    };
    const service = {
      translateMany: vi.fn((
        _inputs: readonly TranslationInput[],
        _settings: ReaderSettings,
        _signal: AbortSignal,
        _priority: "prefetch",
        _onProgress?: (complete: number, total: number) => void,
        onOutput?: (value: TranslationOutput) => void,
      ) => {
        onOutput?.(output);
        return Promise.resolve([output]);
      }),
    };
    const scope = new LifecycleScope();
    const translator = new HostTitleTranslator(document, scope, settingsStore, service);
    const onTranslation = vi.fn();

    await translator.translateComments(
      [{ id: 49327487, html: "Thanks" }],
      new AbortController().signal,
      onTranslation,
    );

    expect(service.translateMany).toHaveBeenCalledWith(
      [{ id: 49327487, html: "Thanks", translateShortText: true }],
      activeSettings,
      expect.any(AbortSignal),
      "prefetch",
      undefined,
      expect.any(Function),
    );
    expect(onTranslation).toHaveBeenCalledOnce();
    expect(onTranslation).toHaveBeenCalledWith(output);
    scope.destroy();
  });

  it("does not initialize the translation path while automatic translation is disabled", async () => {
    const settingsStore = new SettingsStore();
    vi.spyOn(settingsStore, "load").mockReturnValue(DEFAULT_SETTINGS);
    const service = { translateMany: vi.fn() };
    const scope = new LifecycleScope();
    const translator = new HostTitleTranslator(document, scope, settingsStore, service);

    await translator.translateComments([
      { id: 49327487, html: "A complete user comment." },
    ], new AbortController().signal, vi.fn());

    expect(service.translateMany).not.toHaveBeenCalled();
    scope.destroy();
  });

  it("submits the complete host page as one prefetch operation", async () => {
    const settingsStore = new SettingsStore();
    vi.spyOn(settingsStore, "load").mockReturnValue({ ...DEFAULT_SETTINGS, translationEnabled: true });
    const service = { translateMany: vi.fn((
      _inputs: readonly TranslationInput[],
      _settings: ReaderSettings,
      _signal: AbortSignal,
      _priority: "prefetch",
      _onProgress?: (complete: number, total: number) => void,
      _onOutput?: (value: TranslationOutput) => void,
    ) => {
      void [_inputs, _settings, _signal, _priority, _onProgress, _onOutput];
      return Promise.resolve([]);
    }) };
    const scope = new LifecycleScope();
    const translator = new HostTitleTranslator(document, scope, settingsStore, service);

    await translator.translateMany(Array.from({ length: 5 }, (_, index) => ({
      id: (index + 1) as never,
      title: index === 0 ? "Delta" : `Story title ${index + 1}`,
    })), new AbortController().signal, vi.fn());

    expect(service.translateMany).toHaveBeenCalledOnce();
    expect(service.translateMany.mock.calls[0]?.[0]).toEqual([
      { id: 1, html: "Delta", translateShortText: true },
      { id: 2, html: "Story title 2", translateShortText: true },
      { id: 3, html: "Story title 3", translateShortText: true },
      { id: 4, html: "Story title 4", translateShortText: true },
      { id: 5, html: "Story title 5", translateShortText: true },
    ]);
    expect(service.translateMany.mock.calls[0]?.[3]).toBe("prefetch");
    scope.destroy();
  });

  it("cancels active host translation when its host projection is replaced", async () => {
    const settingsStore = new SettingsStore();
    vi.spyOn(settingsStore, "load").mockReturnValue({ ...DEFAULT_SETTINGS, translationEnabled: true });
    let requestSignal: AbortSignal | undefined;
    const service = { translateMany: vi.fn((
      _inputs: readonly TranslationInput[],
      _settings: ReaderSettings,
      signal: AbortSignal,
      _priority: "prefetch",
    ) => {
      void [_inputs, _settings, _priority];
      requestSignal = signal;
      return new Promise<readonly TranslationOutput[]>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(
          signal.reason instanceof Error ? signal.reason : new Error("宿主翻译已取消"),
        ), { once: true });
      });
    }) };
    const scope = new LifecycleScope();
    const translator = new HostTitleTranslator(document, scope, settingsStore, service);
    const projection = new AbortController();
    const pending = translator.translateMany([{ id: 1 as never, title: "Background story title" }], projection.signal, vi.fn());
    await vi.waitFor(() => expect(requestSignal).toBeInstanceOf(AbortSignal));

    projection.abort(new Error("宿主页面投影已替换"));

    await expect(pending).rejects.toThrow("宿主页面投影已替换");
    expect(requestSignal?.aborted).toBe(true);
    scope.destroy();
  });
});
