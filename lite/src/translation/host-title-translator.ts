import { AiCompletionClient } from "../ai/ai-completion-client";
import { CacheRepository } from "../cache/cache-repository";
import { IndexedDbCacheStore } from "../cache/indexeddb-cache-store";
import { LifecycleScope } from "../kernel/lifecycle";
import { GmHttpClient } from "../network/gm-http-client";
import { RequestScheduler } from "../network/request-scheduler";
import { SettingsStore, type ReaderSettings } from "../settings/settings-store";
import type { StoryId } from "../thread/model";
import {
  TranslationService,
  type CachedTranslation,
  type TranslationInput,
  type TranslationOutput,
} from "./translation-service";
import { TRANSLATION_MAX_CONCURRENT, TranslationTaskManager } from "./translation-task-manager";

interface HostTranslationService {
  translateMany(
    inputs: readonly TranslationInput[],
    settings: ReaderSettings,
    signal: AbortSignal,
    priority: "prefetch",
    onProgress?: (complete: number, total: number) => void,
    onOutput?: (output: TranslationOutput) => void,
  ): Promise<readonly TranslationOutput[]>;
}

/** Lazily owns the translation stack used by automatic host-page translations. */
export class HostTitleTranslator {
  readonly #scope: LifecycleScope;
  #service: HostTranslationService | null;

  constructor(
    readonly document: Document,
    parentScope: LifecycleScope,
    readonly settingsStore = new SettingsStore(),
    service: HostTranslationService | null = null,
  ) {
    this.#scope = parentScope.child();
    this.#service = service;
  }

  async translateMany(
    titles: readonly { readonly id: StoryId; readonly title: string }[],
    signal: AbortSignal,
    onTranslation: (output: TranslationOutput) => void,
  ): Promise<void> {
    await this.#translate(
      titles.map(({ id, title }) => ({ id, html: title, translateShortText: true })),
      signal,
      onTranslation,
    );
  }

  async translateComments(
    comments: readonly { readonly id: number; readonly html: string }[],
    signal: AbortSignal,
    onTranslation: (output: TranslationOutput) => void,
  ): Promise<void> {
    await this.#translate(
      comments.map(({ id, html }) => ({ id, html, translateShortText: true })),
      signal,
      onTranslation,
    );
  }

  async #translate(
    inputs: readonly TranslationInput[],
    upstream: AbortSignal,
    onTranslation: (output: TranslationOutput) => void,
  ): Promise<void> {
    const settings = this.settingsStore.load();
    if (!settings.translationEnabled || inputs.length === 0 || this.#scope.destroyed) {
      return;
    }
    const operationScope = this.#scope.child();
    const controller = operationScope.abortController(new Error("宿主翻译已取消"), upstream);
    try {
      controller.signal.throwIfAborted();
      await this.#translationService().translateMany(
        inputs,
        settings,
        controller.signal,
        "prefetch",
        undefined,
        onTranslation,
      );
    } finally {
      operationScope.destroy();
    }
  }

  #translationService(): HostTranslationService {
    if (this.#service) return this.#service;
    const scheduler = new RequestScheduler(TRANSLATION_MAX_CONCURRENT);
    const tasks = new TranslationTaskManager({ maxConcurrent: TRANSLATION_MAX_CONCURRENT });
    const cacheStore = new IndexedDbCacheStore<CachedTranslation>(
      "hacker-news-reader-translations",
      "cache-v1",
    );
    const http = new GmHttpClient(scheduler);
    this.#service = new TranslationService(
      this.document,
      http,
      tasks,
      new CacheRepository(cacheStore),
      new AiCompletionClient(http),
    );
    this.#scope.add(() => scheduler.destroy());
    this.#scope.add(() => tasks.destroy());
    this.#scope.add(() => { void cacheStore.close(); });
    return this.#service;
  }
}
