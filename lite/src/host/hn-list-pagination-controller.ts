import { LifecycleScope } from "../kernel/lifecycle";
import type { FetchedHnListPage } from "./hn-list-page-adapter";
import { findHnMoreLink } from "./hn-list-dom";

export interface HnListPageLoader {
  load(rawUrl: string, signal?: AbortSignal): Promise<FetchedHnListPage>;
}

export interface HnListPaginationHost {
  nextPageUrl(): string | null;
  appendListPage(page: Document): number;
}

interface ScrollMetrics {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export class HnListPaginationController {
  readonly #scope: LifecycleScope;
  #scheduled = false;
  #frameCheck: number | null = null;
  #loading = false;
  #suspendedForHostNavigation = false;
  #loadController: AbortController | null = null;
  #pageGeneration = 0;
  #retryNotBefore = 0;
  readonly #loadedUrls = new Set<string>();
  readonly #automaticRetryUrls = new Set<string>();
  #moreObserver: IntersectionObserver | null = null;
  #observedMore: HTMLAnchorElement | null = null;

  constructor(
    readonly document: Document,
    readonly loader: HnListPageLoader,
    readonly host: HnListPaginationHost,
    parentScope: LifecycleScope,
    readonly now: () => number = Date.now,
    readonly retryDelayMs = 3_000,
  ) {
    this.#scope = parentScope.child();
  }

  install(): void {
    const onScroll = (): void => {
      this.#scheduleCheck();
    };
    const onScrollIntent = (): void => {
      this.#scheduleFrameCheck();
    };
    const pageWindow = this.document.defaultView;
    if (pageWindow) {
      this.#scope.listen(pageWindow, "scroll", onScroll, { passive: true });
      this.#scope.add(() => {
        if (this.#frameCheck !== null) pageWindow.cancelAnimationFrame(this.#frameCheck);
        this.#frameCheck = null;
      });
    }
    this.#scope.listen(this.document, "scroll", onScroll, { capture: true, passive: true });
    this.#scope.listen(this.document, "wheel", onScrollIntent, { capture: true, passive: true });
    this.#scope.listen(this.document, "touchmove", onScrollIntent, { capture: true, passive: true });
    this.#scope.listen(this.document, "keydown", (event) => {
      if (!(event instanceof KeyboardEvent)) return;
      if (["ArrowDown", "End", "PageDown", " "].includes(event.key)) onScrollIntent();
    }, { capture: true });
    const embeddedScroller = this.document.querySelector<HTMLElement>("body > center");
    if (embeddedScroller) {
      this.#scope.listen(embeddedScroller, "scroll", onScroll, { passive: true });
    }
    try {
      const IntersectionObserverConstructor = pageWindow?.IntersectionObserver;
      if (IntersectionObserverConstructor) {
        this.#moreObserver = new IntersectionObserverConstructor((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) this.#scheduleCheck();
        }, { root: null, rootMargin: "480px 0px" });
        this.#scope.add(() => this.#moreObserver?.disconnect());
        this.#observeMore();
      }
    } catch {
      this.#moreObserver = null;
      this.#observedMore = null;
    }
  }

  destroy(): void {
    this.#scope.destroy();
  }

  resetForListPage(): void {
    this.#suspendedForHostNavigation = false;
    this.#pageGeneration += 1;
    this.#loadController?.abort(new Error("HN 列表页已切换"));
    this.#loadController = null;
    this.#loading = false;
    this.#retryNotBefore = 0;
    this.#loadedUrls.clear();
    this.#automaticRetryUrls.clear();
    this.#observedMore = null;
    this.#observeMore();
  }

  suspendForHostNavigation(): void {
    this.#suspendedForHostNavigation = true;
    this.#pageGeneration += 1;
    this.#loadController?.abort(new Error("HN 分页已让位给宿主导航"));
    this.#loadController = null;
    this.#loading = false;
  }

  #scheduleCheck(): void {
    if (this.#scheduled || this.#scope.destroyed) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      if (!this.#scope.destroyed) void this.#loadIfNeeded();
    });
  }

  async #loadIfNeeded(): Promise<void> {
    if (
      this.#suspendedForHostNavigation
      || this.#loading
      || this.now() < this.#retryNotBefore
    ) return;
    const rawUrl = this.host.nextPageUrl();
    if (!rawUrl) return;
    const url = new URL(rawUrl, this.document.baseURI).href;
    if (this.#loadedUrls.has(url)) return;

    const more = findHnMoreLink(this.document);
    if (!more || !this.#moreIsNearViewport(more)) return;
    const pageGeneration = this.#pageGeneration;
    const previousText = more?.textContent ?? "More";
    let restoredText = previousText;
    if (more) {
      more.dataset.hnrLoading = "true";
      more.textContent = "Loading…";
      more.setAttribute("aria-busy", "true");
    }
    this.#loading = true;
    const controller = new AbortController();
    this.#loadController = controller;
    const release = this.#scope.add(() => controller.abort(new Error("宿主列表已关闭")));
    try {
      const page = await this.loader.load(url, controller.signal);
      if (this.#scope.destroyed || pageGeneration !== this.#pageGeneration) return;
      const appendedStories = this.host.appendListPage(page.document);
      if (appendedStories === 0 && this.host.nextPageUrl() === url) {
        throw new Error("HN 下一页没有可追加的故事");
      }
      this.#loadedUrls.add(url);
      this.#retryNotBefore = 0;
      this.#observeMore();
      this.#scheduleCheck();
    } catch {
      if (!this.#scope.destroyed && pageGeneration === this.#pageGeneration) {
        this.#retryNotBefore = this.now() + this.retryDelayMs;
        if (!this.#scheduleAutomaticRetry(url)) {
          restoredText = `${previousText} · 自动加载失败，点击继续`;
        }
      }
    } finally {
      release();
      if (this.#loadController === controller) this.#loadController = null;
      if (pageGeneration === this.#pageGeneration) this.#loading = false;
      if (more?.isConnected) {
        more.removeAttribute("data-hnr-loading");
        more.removeAttribute("aria-busy");
        more.textContent = restoredText;
      }
    }
  }

  #scheduleFrameCheck(): void {
    if (this.#frameCheck !== null || this.#scope.destroyed) return;
    const pageWindow = this.document.defaultView;
    if (!pageWindow) {
      this.#scheduleCheck();
      return;
    }
    this.#frameCheck = pageWindow.requestAnimationFrame(() => {
      this.#frameCheck = null;
      this.#scheduleCheck();
    });
  }

  #observeMore(): void {
    if (!this.#moreObserver) return;
    const more = findHnMoreLink(this.document);
    if (more === this.#observedMore) return;
    this.#moreObserver.disconnect();
    this.#observedMore = more;
    if (more) this.#moreObserver.observe(more);
  }

  #moreIsNearViewport(more: HTMLAnchorElement): boolean {
    const metrics = this.#scrollMetrics();
    const threshold = Math.max(480, Math.round(metrics.clientHeight * 0.75));
    const moreRect = more.getBoundingClientRect();
    const hasLayoutRect = moreRect.height > 0 || moreRect.top !== 0 || moreRect.bottom !== 0;
    if (hasLayoutRect) {
      const embeddedScroller = this.document.querySelector<HTMLElement>("body > center");
      const embedded = embeddedScroller
        && this.document.documentElement.classList.contains("hnr-reader-embedded-right");
      const viewportBottom = embedded
        ? embeddedScroller.getBoundingClientRect().bottom
        : (this.document.defaultView?.innerHeight ?? metrics.clientHeight);
      return moreRect.top <= viewportBottom + threshold;
    }
    const remaining = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
    return remaining <= threshold;
  }

  #scheduleAutomaticRetry(url: string): boolean {
    if (this.#automaticRetryUrls.has(url)) return false;
    this.#automaticRetryUrls.add(url);
    const pageWindow = this.document.defaultView;
    if (!pageWindow) return false;
    const timer = pageWindow.setTimeout(() => {
      this.#scheduleCheck();
    }, this.retryDelayMs + 1);
    this.#scope.timer(timer, (id) => pageWindow.clearTimeout(id));
    return true;
  }

  #scrollMetrics(): ScrollMetrics {
    const embeddedScroller = this.document.querySelector<HTMLElement>("body > center");
    if (
      embeddedScroller
      && this.document.documentElement.classList.contains("hnr-reader-embedded-right")
    ) {
      return embeddedScroller;
    }
    return this.document.scrollingElement ?? this.document.documentElement;
  }
}
