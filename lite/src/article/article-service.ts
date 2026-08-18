import type { CacheRepository } from "../cache/cache-repository";
import { hashText } from "../kernel/hash";
import type { ArticleSnapshot } from "./article-extractor";
import { ArticleExtractor } from "./article-extractor";
import type { ArticleFetchAdapter } from "./article-fetch-adapter";
import { assertSafeExternalUrl } from "./url-policy";

export class ArticleService {
  constructor(
    readonly document: Document,
    readonly fetcher: ArticleFetchAdapter,
    readonly extractor: ArticleExtractor,
    readonly cache: CacheRepository<ArticleSnapshot>,
  ) {}

  async load(rawUrl: string, signal?: AbortSignal, fresh = false): Promise<ArticleSnapshot> {
    const url = assertSafeExternalUrl(rawUrl).href;
    const key = `article:v1:${hashText(url)}`;
    if (!fresh) {
      const cached = await this.cache.get(key);
      if (cached) return cached;
    }
    const fetched = await this.fetcher.fetch(url, signal);
    const article = this.extractor.extract(fetched, this.document);
    await this.cache.set(key, article);
    return article;
  }
}
