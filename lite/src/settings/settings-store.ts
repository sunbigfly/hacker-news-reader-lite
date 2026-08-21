import {
  DEFAULT_READER_TRANSLATION_THEME,
  normalizeReaderTranslationTheme,
  type ReaderTranslationTheme,
} from "../translation/translation-presentation";

export type TranslationProviderChoice = "auto" | "google" | "microsoft" | "ai";
export type TranslationDisplayMode = "original" | "bilingual" | "translated";
export type ReaderTheme = "auto" | "light" | "dark";
export type ReaderFontFamily = "system" | "cjkSans" | "serif" | "monospace" | "custom";
export type ReaderFontWeight = 300 | 400 | 500 | 600;

export const READER_FONT_FAMILIES = Object.freeze<readonly ReaderFontFamily[]>([
  "system",
  "cjkSans",
  "serif",
  "monospace",
  "custom",
]);

export const READER_FONT_FAMILY_LABELS = Object.freeze<Record<ReaderFontFamily, string>>({
  system: "系统默认字体",
  cjkSans: "中文无衬线",
  serif: "衬线",
  monospace: "等宽",
  custom: "自定义本机字体",
});

export const READER_FONT_WEIGHTS = Object.freeze<readonly ReaderFontWeight[]>([
  300,
  400,
  500,
  600,
]);

const FONT_STACKS = Object.freeze<Record<Exclude<ReaderFontFamily, "custom">, string>>({
  system: "system-ui,-apple-system,BlinkMacSystemFont,\"Segoe UI\",sans-serif",
  cjkSans: "\"Noto Sans CJK SC\",\"Microsoft YaHei\",\"PingFang SC\",system-ui,sans-serif",
  serif: "ui-serif,Charter,\"Noto Serif CJK SC\",\"Songti SC\",Georgia,serif",
  monospace: "ui-monospace,SFMono-Regular,Consolas,monospace",
});

export interface AiProfile {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly prompt: string;
  readonly requestsPerMinute: number;
  readonly tokensPerMinute: number;
}

export interface ReaderSettings {
  readonly schemaVersion: 1;
  readonly translationEnabled: boolean;
  readonly translationProvider: TranslationProviderChoice;
  readonly translationMode: TranslationDisplayMode;
  readonly translationTheme: ReaderTranslationTheme;
  readonly targetLanguage: "zh-CN";
  readonly ai: AiProfile;
  readonly titleFontFamily: ReaderFontFamily;
  readonly titleCustomFontFamily: string;
  readonly fontFamily: ReaderFontFamily;
  readonly customFontFamily: string;
  readonly fontRenderingEnabled: boolean;
  readonly fontWeight: ReaderFontWeight;
  readonly fontScale: number;
  readonly lineHeight: number;
  readonly theme: ReaderTheme;
}

export const DEFAULT_SETTINGS: ReaderSettings = Object.freeze({
  schemaVersion: 1,
  translationEnabled: false,
  translationProvider: "auto",
  translationMode: "bilingual",
  translationTheme: DEFAULT_READER_TRANSLATION_THEME,
  targetLanguage: "zh-CN",
  ai: Object.freeze({
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4.1-mini",
    prompt: "将用户提供的 Hacker News 英文内容翻译成自然、准确的中文；忠实保留原文事实、观点、语气、讽刺、幽默和讨论气质，不增删、不解释；表达符合中文技术社区习惯，避免生硬直译和过度书面化；俚语、俗语、梗语自然本地化，但保持原意和语气准确；技术术语使用通用译法，无可靠译法时保留英文；代码、命令、URL、Markdown、变量名、文件名、API、占位符等原样保留；保持原有格式；只输出译文，不添加说明、摘要、注释或前导语。",
    requestsPerMinute: 0,
    tokensPerMinute: 0,
  }),
  titleFontFamily: "system",
  titleCustomFontFamily: "",
  fontFamily: "system",
  customFontFamily: "",
  fontRenderingEnabled: true,
  fontWeight: 500,
  fontScale: 0.92,
  lineHeight: 1.52,
  theme: "auto",
});

const STORAGE_KEY = "hn-reader:settings:v1";
const FORBIDDEN_FONT_FAMILY_CHARACTERS = new Set(["\"", "'", "`", ",", ";", "{", "}", "<", ">", "\\"]);

function numberInRange(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback;
}

function normalizeCustomFontFamily(value: unknown): string {
  if (typeof value !== "string") return "";
  let normalized = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f || FORBIDDEN_FONT_FAMILY_CHARACTERS.has(character)) continue;
    normalized += /\s/u.test(character) ? " " : character;
  }
  return normalized.replace(/\s+/gu, " ").trim().slice(0, 64);
}

export function readerFontFamilyCss(family: ReaderFontFamily, customFamily = ""): string {
  if (family !== "custom") return FONT_STACKS[family];
  const normalized = normalizeCustomFontFamily(customFamily);
  return normalized ? `${JSON.stringify(normalized)},${FONT_STACKS.system}` : FONT_STACKS.system;
}

export function normalizeAiBaseUrl(raw: string): string {
  const url = new URL(raw.trim());
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.username || url.password || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) {
    throw new Error("AI Base URL 必须使用 HTTPS；本机服务可使用 HTTP");
  }
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/+$/, "");
}

export function normalizeSettings(value: unknown): ReaderSettings {
  const record = value && typeof value === "object" ? value as Partial<ReaderSettings> : {};
  const aiRecord = record.ai && typeof record.ai === "object" ? record.ai : DEFAULT_SETTINGS.ai;
  const providers = new Set<TranslationProviderChoice>(["auto", "google", "microsoft", "ai"]);
  const modes = new Set<TranslationDisplayMode>(["original", "bilingual", "translated"]);
  const themes = new Set<ReaderTheme>(["auto", "light", "dark"]);
  const titleFontFamily = READER_FONT_FAMILIES.includes(record.titleFontFamily as ReaderFontFamily)
    ? record.titleFontFamily as ReaderFontFamily
    : DEFAULT_SETTINGS.titleFontFamily;
  const fontFamily = READER_FONT_FAMILIES.includes(record.fontFamily as ReaderFontFamily)
    ? record.fontFamily as ReaderFontFamily
    : DEFAULT_SETTINGS.fontFamily;
  const fontWeight = READER_FONT_WEIGHTS.includes(Number(record.fontWeight) as ReaderFontWeight)
    ? Number(record.fontWeight) as ReaderFontWeight
    : DEFAULT_SETTINGS.fontWeight;
  return {
    schemaVersion: 1,
    translationEnabled: typeof record.translationEnabled === "boolean" ? record.translationEnabled : DEFAULT_SETTINGS.translationEnabled,
    translationProvider: providers.has(record.translationProvider as TranslationProviderChoice) ? record.translationProvider as TranslationProviderChoice : DEFAULT_SETTINGS.translationProvider,
    translationMode: modes.has(record.translationMode as TranslationDisplayMode) ? record.translationMode as TranslationDisplayMode : DEFAULT_SETTINGS.translationMode,
    translationTheme: normalizeReaderTranslationTheme(record.translationTheme),
    targetLanguage: "zh-CN",
    ai: {
      baseUrl: typeof aiRecord.baseUrl === "string" ? aiRecord.baseUrl : DEFAULT_SETTINGS.ai.baseUrl,
      apiKey: typeof aiRecord.apiKey === "string" ? aiRecord.apiKey : "",
      model: typeof aiRecord.model === "string" && aiRecord.model.trim() ? aiRecord.model.trim() : DEFAULT_SETTINGS.ai.model,
      prompt: typeof aiRecord.prompt === "string" ? aiRecord.prompt.slice(0, 4_000) : DEFAULT_SETTINGS.ai.prompt,
      requestsPerMinute: Math.floor(numberInRange(aiRecord.requestsPerMinute, 0, 0, 10_000)),
      tokensPerMinute: Math.floor(numberInRange(aiRecord.tokensPerMinute, 0, 0, 10_000_000)),
    },
    titleFontFamily,
    titleCustomFontFamily: normalizeCustomFontFamily(record.titleCustomFontFamily),
    fontFamily,
    customFontFamily: normalizeCustomFontFamily(record.customFontFamily),
    fontRenderingEnabled: record.fontRenderingEnabled !== false,
    fontWeight,
    fontScale: numberInRange(record.fontScale, DEFAULT_SETTINGS.fontScale, 0.85, 1.35),
    lineHeight: numberInRange(record.lineHeight, DEFAULT_SETTINGS.lineHeight, 1.35, 2),
    theme: themes.has(record.theme as ReaderTheme) ? record.theme as ReaderTheme : DEFAULT_SETTINGS.theme,
  };
}

export class SettingsStore {
  load(): ReaderSettings {
    if (typeof GM_getValue !== "function") return DEFAULT_SETTINGS;
    return normalizeSettings(GM_getValue<unknown>(STORAGE_KEY, DEFAULT_SETTINGS));
  }

  save(settings: ReaderSettings): void {
    const normalized = normalizeSettings(settings);
    if (normalized.translationProvider === "ai") {
      normalizeAiBaseUrl(normalized.ai.baseUrl);
      if (!normalized.ai.apiKey.trim() || !normalized.ai.model.trim()) throw new Error("AI 翻译需要 API Key 与模型");
    }
    if (typeof GM_setValue === "function") GM_setValue(STORAGE_KEY, normalized);
  }

  reset(): void {
    if (typeof GM_deleteValue === "function") GM_deleteValue(STORAGE_KEY);
  }
}
