import type { Cleanup, LifecycleScope } from "../kernel/lifecycle";

const ENTRY_KEY = "hnrReaderBackEntry";
let nextEntry = 0;

/** One same-document back step for the visible mobile Reader. */
export class ReaderBackNavigation {
  #active = false;
  #entry: { token: string; url: string; state: unknown } | null = null;
  #returning = false;
  #unlisten: Cleanup | null = null;
  #scrollRestoration: ScrollRestoration | undefined;
  #restoreTimer: number | null = null;

  constructor(
    readonly pageWindow: Window | null,
    readonly scope: LifecycleScope,
    readonly onBack: () => void,
  ) {
    scope.add(() => {
      if (this.#ownsEntry() && this.#entry) {
        pageWindow?.history.replaceState(this.#entry.state, "", this.#entry.url);
      }
      this.#unlisten?.();
      this.#restoreScrolling();
    });
  }

  setActive(active: boolean): void {
    this.#active = active;
    const view = this.pageWindow;
    if (!view || this.scope.destroyed || this.#returning) return;
    if (!active) {
      if (this.#ownsEntry()) {
        this.#returning = true;
        view.history.back();
      } else if (this.#entry) {
        this.#releaseEntry();
      }
      return;
    }
    if (this.#ownsEntry()) return;
    this.#entry = {
      token: `${Date.now()}-${++nextEntry}`,
      url: view.location.href,
      state: view.history.state,
    };
    if (this.#restoreTimer !== null) view.clearTimeout(this.#restoreTimer);
    this.#restoreTimer = null;
    this.#scrollRestoration ??= view.history.scrollRestoration;
    view.history.scrollRestoration = "manual";
    view.history.pushState({ ...view.history.state, [ENTRY_KEY]: this.#entry.token }, "", this.#entry.url);
    this.#unlisten ??= this.scope.listen(view, "popstate", (event) => {
      if (!this.#entry || this.#ownsEntry()) return;
      // The host's popstate handler must not refetch the unchanged background page.
      if (view.location.href === this.#entry.url) event.stopImmediatePropagation();
      const returning = this.#returning;
      this.#releaseEntry();
      if (returning) {
        if (this.#active) this.setActive(true);
      } else {
        this.#active = false;
        this.onBack();
      }
    }, { capture: true });
  }

  #ownsEntry(): boolean {
    const state: unknown = this.pageWindow?.history.state;
    return !!this.#entry && typeof state === "object" && state !== null
      && ENTRY_KEY in state && state[ENTRY_KEY] === this.#entry.token;
  }

  #releaseEntry(): void {
    this.#entry = null;
    this.#returning = false;
    this.#unlisten?.();
    this.#unlisten = null;
    // Keep manual restoration until the browser finishes this history traversal.
    if (this.#restoreTimer !== null) this.pageWindow?.clearTimeout(this.#restoreTimer);
    this.#restoreTimer = this.pageWindow?.setTimeout(() => this.#restoreScrolling(), 0) ?? null;
  }

  #restoreScrolling(): void {
    if (this.#restoreTimer !== null) this.pageWindow?.clearTimeout(this.#restoreTimer);
    this.#restoreTimer = null;
    if (this.pageWindow && this.#scrollRestoration !== undefined) {
      this.pageWindow.history.scrollRestoration = this.#scrollRestoration;
    }
    this.#scrollRestoration = undefined;
  }
}
