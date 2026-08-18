import type { LifecycleScope } from "../kernel/lifecycle";
import type { FetchedHnHostPage } from "./hn-host-page-adapter";

const NATIVE_ACTION_PATHS = new Set([
  "/comment",
  "/delete-confirm",
  "/fave",
  "/flag",
  "/hide",
  "/logout",
  "/vote",
]);

const CACHEABLE_TAB_PATHS = new Set([
  "/ask",
  "/front",
  "/jobs",
  "/newcomments",
  "/news",
  "/newest",
  "/newswelcome.html",
  "/show",
  "/threads",
]);
const HOST_NAVIGATION_PATHS = new Set([
  ...CACHEABLE_TAB_PATHS,
  "/",
  "/reply",
  "/submit",
]);
const HOST_TAB_CACHE_LIMIT = 12;

export function isHnHostPanelPath(pathname: string): boolean {
  return HOST_NAVIGATION_PATHS.has(pathname);
}

export interface HnHostNavigationLoader {
  load(rawUrl: string, signal?: AbortSignal): Promise<FetchedHnHostPage>;
}

export interface HnHostNavigationTarget {
  replaceHostPage(page: Document, finalUrl: string): boolean;
}

function hnInternalUrl(rawUrl: string, baseUrl: string): URL | null {
  let url: URL;
  try {
    url = new URL(rawUrl, baseUrl);
  } catch {
    return null;
  }
  if (url.protocol === "http:" && url.hostname === "news.ycombinator.com") {
    url.protocol = "https:";
  }
  if (
    url.protocol !== "https:"
    || url.hostname !== "news.ycombinator.com"
    || url.port
    || url.username
    || url.password
    || NATIVE_ACTION_PATHS.has(url.pathname)
  ) {
    return null;
  }
  return url;
}

function hostNavigationUrl(rawUrl: string, baseUrl: string): URL | null {
  const url = hnInternalUrl(rawUrl, baseUrl);
  return url && isHnHostPanelPath(url.pathname) ? url : null;
}

function readerItemId(url: URL): number | null {
  if (url.pathname !== "/item") return null;
  const id = Number.parseInt(url.searchParams.get("id") ?? "", 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function eventTargetElement(event: Event): Element | null {
  const target = event.target;
  return target && "nodeType" in target && target.nodeType === 1
    ? target as Element
    : null;
}

function isSameDocumentHash(url: URL, currentUrl: string): boolean {
  if (!url.hash) return false;
  const current = new URL(currentUrl);
  return url.origin === current.origin
    && url.pathname === current.pathname
    && url.search === current.search;
}

function hashTargetId(url: URL): string {
  const raw = url.hash.slice(1);
  if (!raw) return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function tabPageCacheKey(url: URL): string | null {
  if (!CACHEABLE_TAB_PATHS.has(url.pathname)) return null;
  const cacheUrl = new URL(url.href);
  cacheUrl.hash = "";
  return cacheUrl.href;
}

function pageFingerprint(page: FetchedHnHostPage): string {
  return `${page.finalUrl}\n${page.document.documentElement.outerHTML}`;
}

interface CachedHnHostPage {
  readonly page: FetchedHnHostPage;
  readonly fingerprint: string;
}

/** Keeps read-only HN navigation inside the host pane while Reader remains mounted. */
export class HnHostNavigationController {
  readonly #scope: LifecycleScope;
  #requestController: AbortController | null = null;
  #generation = 0;
  #notice: HTMLElement | null = null;
  readonly #pageCache = new Map<string, CachedHnHostPage>();

  constructor(
    readonly document: Document,
    readonly loader: HnHostNavigationLoader,
    readonly host: HnHostNavigationTarget,
    readonly onHostNavigationSettled: () => void,
    parentScope: LifecycleScope,
    readonly onHostNavigationStart: () => void = () => undefined,
    readonly onOpenItem?: (itemId: number) => void,
  ) {
    this.#scope = parentScope.child();
  }

  install(): void {
    this.#scope.listen(
      this.document,
      "click",
      (event) => this.#handleClick(event),
      { capture: true },
    );
    const pageWindow = this.document.defaultView;
    if (pageWindow) {
      this.#scope.listen(pageWindow, "popstate", () => {
        const url = hostNavigationUrl(pageWindow.location.href, this.document.baseURI);
        if (url) void this.#navigate(url, false);
      });
    }
    this.#scope.add(() => {
      this.#setBusy(false);
      this.#notice?.remove();
      this.#notice = null;
    });
  }

  destroy(): void {
    this.#scope.destroy();
  }

  navigate(rawUrl: string): Promise<boolean> {
    const url = this.#resolveUrl(rawUrl);
    return url ? this.#navigate(url, true) : Promise.resolve(false);
  }

  showHostPage(rawUrl: string): Promise<boolean> {
    const url = this.#resolveUrl(rawUrl);
    return url ? this.#navigate(url, false) : Promise.resolve(false);
  }

  #handleClick(event: Event): void {
    const mouseEvent = event as MouseEvent;
    if (event.defaultPrevented || mouseEvent.button !== 0) return;
    if (mouseEvent.altKey || mouseEvent.ctrlKey || mouseEvent.metaKey || mouseEvent.shiftKey) return;
    const target = eventTargetElement(event);
    if (target?.closest("[data-hnr-host-back]")) {
      event.preventDefault();
      this.#goBack();
      return;
    }
    const anchor = target?.closest<HTMLAnchorElement>("body > center a[href]") ?? null;
    if (!anchor || anchor.hasAttribute("download")) return;
    if (anchor.target && anchor.target !== "_self") return;
    if (anchor.closest("[data-hnr-card-open] .titleline,[data-hnr-comment-card]")) return;
    if (
      anchor.closest("[data-hnr-topbar-navigation]")
      && !this.document.documentElement.classList.contains("hnr-reader-embedded-right")
    ) return;
    const internalUrl = hnInternalUrl(anchor.href, this.document.baseURI);
    if (!internalUrl) return;
    const pageWindow = this.document.defaultView;
    if (pageWindow && isSameDocumentHash(internalUrl, pageWindow.location.href)) return;
    const itemId = readerItemId(internalUrl);
    if (itemId !== null) {
      if (!this.onOpenItem) return;
      event.preventDefault();
      this.onOpenItem(itemId);
      return;
    }
    const url = this.#resolveUrl(internalUrl.href);
    if (!url) return;
    event.preventDefault();
    void this.#navigate(url, true);
  }

  #resolveUrl(rawUrl: string): URL | null {
    const url = hostNavigationUrl(rawUrl, this.document.baseURI);
    if (!url || url.pathname !== "/threads" || url.searchParams.has("id")) return url;
    const profile = this.document.querySelector<HTMLAnchorElement>(
      '[data-hnr-topbar-account] a[href^="user?id="]',
    );
    if (!profile) return url;
    let username: string | undefined;
    try {
      username = new URL(profile.href, this.document.baseURI).searchParams.get("id")?.trim();
    } catch {
      return url;
    }
    if (username) url.searchParams.set("id", username);
    return url;
  }

  #goBack(): void {
    const pageWindow = this.document.defaultView;
    const state = pageWindow?.history.state as { readonly hnrHostReturnUrl?: unknown } | null;
    if (pageWindow && typeof state?.hnrHostReturnUrl === "string") {
      pageWindow.history.back();
      return;
    }
    void this.navigate("/news");
  }

  async #navigate(url: URL, pushHistory: boolean): Promise<boolean> {
    const generation = ++this.#generation;
    this.#requestController?.abort(new Error("HN 宿主导航已被新目标替代"));
    const controller = new AbortController();
    this.#requestController = controller;
    const release = this.#scope.add(() => {
      if (!controller.signal.aborted) controller.abort(new Error("HN 宿主导航已关闭"));
    });
    this.#notice?.remove();
    this.#notice = null;
    const cacheKey = tabPageCacheKey(url);
    const cached = cacheKey ? this.#takeCachedPage(cacheKey) : null;
    let cachedApplied = false;
    let hostNavigationStarted = false;
    const startHostNavigation = (): void => {
      this.onHostNavigationStart();
      hostNavigationStarted = true;
    };
    const settleHostNavigation = (): void => {
      if (!hostNavigationStarted) return;
      hostNavigationStarted = false;
      if (!this.#scope.destroyed) this.onHostNavigationSettled();
    };
    if (cached) {
      startHostNavigation();
      cachedApplied = this.#applyPage(cached.page, pushHistory, "reset");
      settleHostNavigation();
      if (!cachedApplied && cacheKey) this.#pageCache.delete(cacheKey);
    }
    this.#setBusy(!cachedApplied);
    try {
      if (!cachedApplied) startHostNavigation();
      const page = await this.loader.load(url.href, controller.signal);
      if (this.#scope.destroyed || generation !== this.#generation) return false;
      if (cacheKey) this.#rememberPage(cacheKey, page);
      if (cachedApplied && cached) {
        if (cached.fingerprint === pageFingerprint(page)) {
          this.#showNotice("缓存页面已是最新内容", "success");
          return true;
        }
        startHostNavigation();
        if (!this.#applyPage(page, false, "preserve")) {
          throw new Error("HN 宿主页没有可替换的内容");
        }
        settleHostNavigation();
        this.#showNotice("页面已后台更新", "success");
        return true;
      }
      if (!this.#applyPage(page, pushHistory, "reset")) {
        throw new Error("HN 宿主页没有可替换的内容");
      }
      return true;
    } catch (error) {
      if (!controller.signal.aborted && generation === this.#generation) {
        const message = error instanceof Error ? error.message : "HN 宿主页载入失败";
        if (cachedApplied) {
          this.#showNotice(`后台更新失败，继续显示缓存：${message}`, "error");
          return true;
        }
        this.#showNotice(`HN 宿主载入失败：${message}`, "error");
      }
      return false;
    } finally {
      release();
      if (this.#requestController === controller) this.#requestController = null;
      if (generation === this.#generation) {
        this.#setBusy(false);
        settleHostNavigation();
      }
    }
  }

  #takeCachedPage(key: string): CachedHnHostPage | null {
    const cached = this.#pageCache.get(key) ?? null;
    if (!cached) return null;
    this.#pageCache.delete(key);
    this.#pageCache.set(key, cached);
    return cached;
  }

  #rememberPage(key: string, page: FetchedHnHostPage): void {
    const cached = { page, fingerprint: pageFingerprint(page) };
    this.#pageCache.delete(key);
    this.#pageCache.set(key, cached);
    let finalKey: string | null;
    try {
      finalKey = tabPageCacheKey(new URL(page.finalUrl, this.document.baseURI));
    } catch {
      finalKey = null;
    }
    if (finalKey && finalKey !== key) {
      this.#pageCache.delete(finalKey);
      this.#pageCache.set(finalKey, cached);
    }
    while (this.#pageCache.size > HOST_TAB_CACHE_LIMIT) {
      const oldestKey = this.#pageCache.keys().next().value;
      if (!oldestKey) break;
      this.#pageCache.delete(oldestKey);
    }
  }

  #applyPage(
    page: FetchedHnHostPage,
    pushHistory: boolean,
    scroll: "preserve" | "reset",
  ): boolean {
    const hostScroller = this.document.querySelector<HTMLElement>("body > center");
    const previousScrollTop = hostScroller?.scrollTop ?? 0;
    if (!this.host.replaceHostPage(page.document, page.finalUrl)) return false;
    const pageWindow = this.document.defaultView;
    if (pushHistory && pageWindow) {
      pageWindow.history.pushState({
        hnrHostUrl: page.finalUrl,
        hnrHostReturnUrl: pageWindow.location.href,
      }, "", page.finalUrl);
    }
    if (scroll === "preserve") {
      const currentScroller = this.document.querySelector<HTMLElement>("body > center");
      if (currentScroller) currentScroller.scrollTop = previousScrollTop;
      else pageWindow?.scrollTo({ top: previousScrollTop });
      return true;
    }
    const finalUrl = new URL(page.finalUrl);
    const targetId = hashTargetId(finalUrl);
    const hashTarget = targetId
      ? this.document.getElementById(targetId)
        ?? this.document.getElementsByName(targetId)[0]
      : null;
    if (hashTarget && "scrollIntoView" in hashTarget) {
      hashTarget.scrollIntoView({ block: "start" });
    } else if (hostScroller) hostScroller.scrollTop = 0;
    else pageWindow?.scrollTo({ top: 0 });
    return true;
  }

  #setBusy(busy: boolean): void {
    this.document.documentElement.classList.toggle("hnr-host-page-loading", busy);
    const hostScroller = this.document.querySelector<HTMLElement>("body > center");
    if (busy) hostScroller?.setAttribute("aria-busy", "true");
    else if (hostScroller?.getAttribute("aria-busy") === "true") {
      hostScroller.removeAttribute("aria-busy");
    }
  }

  #showNotice(message: string, tone: "error" | "success"): void {
    this.#notice?.remove();
    const notice = this.document.createElement("div");
    notice.className = "hnr-host-navigation-notice";
    notice.dataset.tone = tone;
    notice.setAttribute("role", "status");
    notice.textContent = message;
    this.document.body.append(notice);
    this.#notice = notice;
    const pageWindow = this.document.defaultView;
    if (pageWindow) {
      const timer = pageWindow.setTimeout(() => {
        if (this.#notice === notice) this.#notice = null;
        notice.remove();
      }, 4_000);
      this.#scope.timer(timer, (id) => pageWindow.clearTimeout(id));
    }
  }
}
