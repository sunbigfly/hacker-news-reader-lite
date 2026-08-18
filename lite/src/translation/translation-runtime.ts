import { AiCompletionClient } from "../ai/ai-completion-client";
import { CacheRepository } from "../cache/cache-repository";
import { IndexedDbCacheStore } from "../cache/indexeddb-cache-store";
import { LifecycleScope } from "../kernel/lifecycle";
import { GmHttpClient } from "../network/gm-http-client";
import { RequestScheduler } from "../network/request-scheduler";
import { TranslationService, type CachedTranslation } from "./translation-service";
import { TRANSLATION_MAX_CONCURRENT, TranslationTaskManager } from "./translation-task-manager";

/**
 * Owns the one page-level translation queue used by both host projections and Reader sessions.
 * Paragraphs keep independent identities while AI requests may pack several entries under a
 * bounded character budget; this runtime coordinates priority promotion, quota and shared cache.
 */
export class TranslationRuntime {
  readonly scheduler = new RequestScheduler(TRANSLATION_MAX_CONCURRENT);
  readonly tasks = new TranslationTaskManager({ maxConcurrent: TRANSLATION_MAX_CONCURRENT });
  readonly cacheStore = new IndexedDbCacheStore<CachedTranslation>(
    "hacker-news-reader-translations",
    "cache-v1",
  );
  readonly cache = new CacheRepository(this.cacheStore);
  readonly service: TranslationService;

  constructor(document: Document, scope: LifecycleScope) {
    const http = new GmHttpClient(this.scheduler);
    this.service = new TranslationService(
      document,
      http,
      this.tasks,
      this.cache,
      new AiCompletionClient(http),
    );
    scope.add(() => this.scheduler.destroy());
    scope.add(() => this.tasks.destroy());
    scope.add(() => { void this.cacheStore.close(); });
  }
}
