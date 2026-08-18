export interface ReaderFontRenderingEnvironment {
  readonly userAgent: string;
  readonly platform: string;
}

export interface ReaderFontRenderingDefaults {
  readonly stroke: number;
  readonly shadow: number;
  readonly macSmoothing: boolean;
}

export function readerFontRenderingDefaults(
  environment: ReaderFontRenderingEnvironment,
): ReaderFontRenderingDefaults {
  const isGecko = /Firefox\//u.test(environment.userAgent);
  const isWebKit = /AppleWebKit\//u.test(environment.userAgent)
    && !/(?:Chrome|Chromium|Edg|OPR|CriOS|FxiOS)\//u.test(environment.userAgent);
  return Object.freeze({
    stroke: isGecko ? 0.03 : isWebKit ? 0.05 : 0.015,
    shadow: isGecko ? 0.55 : isWebKit ? 0.45 : 0.75,
    macSmoothing: /Mac/u.test(environment.platform),
  });
}

/** Applies the built-in rendering profile to the Reader Shadow DOM host. */
export function applyReaderFontRendering(
  root: HTMLElement,
  enabled: boolean,
  environment: ReaderFontRenderingEnvironment,
): void {
  const defaults = readerFontRenderingDefaults(environment);
  root.dataset.fontRendering = enabled ? "builtin" : "off";
  root.style.setProperty(
    "--hnr-font-rendering-stroke-runtime",
    `${defaults.stroke}px currentColor`,
  );
  root.style.setProperty(
    "--hnr-font-rendering-shadow-runtime",
    `0 0 ${defaults.shadow}px #7c7c7cdd`,
  );
  root.toggleAttribute("data-font-mac-smoothing", defaults.macSmoothing);
}
