import { LifecycleScope } from "../kernel/lifecycle";
import {
  readerFontFamilyCss,
  type ReaderSettings,
} from "../settings/settings-store";

const STYLE_PROPERTIES = Object.freeze([
  "--hnr-host-content-font-family",
  "--hnr-host-content-font-weight",
  "--hnr-host-font-scale",
  "--hnr-host-line-height",
] as const);

/** Projects Reader typography onto host comment content. */
export class HnHostReadingSettingsController {
  readonly #html: HTMLElement;

  constructor(document: Document, parentScope: LifecycleScope) {
    this.#html = document.documentElement;
    const previousStyles = new Map(
      STYLE_PROPERTIES.map((property) => [property, this.#html.style.getPropertyValue(property)]),
    );
    parentScope.add(() => {
      for (const [property, value] of previousStyles) {
        if (value) this.#html.style.setProperty(property, value);
        else this.#html.style.removeProperty(property);
      }
    });
  }

  apply(settings: ReaderSettings): void {
    this.#html.style.setProperty(
      "--hnr-host-content-font-family",
      readerFontFamilyCss(settings.fontFamily, settings.customFontFamily),
    );
    this.#html.style.setProperty("--hnr-host-content-font-weight", String(settings.fontWeight));
    this.#html.style.setProperty("--hnr-host-font-scale", String(settings.fontScale));
    this.#html.style.setProperty("--hnr-host-line-height", String(settings.lineHeight));
  }
}
