import { LifecycleScope } from "../kernel/lifecycle";
import type { ReaderTheme } from "../settings/settings-store";

export interface HnHostThemePort {
  apply(theme: ReaderTheme): void;
}

/** Owns the reversible theme projection on the Hacker News host document. */
export class HnHostThemeController implements HnHostThemePort {
  readonly #html: HTMLElement;

  constructor(document: Document, parentScope: LifecycleScope) {
    this.#html = document.documentElement;
    const previousTheme = this.#html.getAttribute("data-hnr-theme");
    parentScope.add(() => {
      if (previousTheme === null) this.#html.removeAttribute("data-hnr-theme");
      else this.#html.setAttribute("data-hnr-theme", previousTheme);
    });
  }

  apply(theme: ReaderTheme): void {
    this.#html.setAttribute("data-hnr-theme", theme);
  }
}
