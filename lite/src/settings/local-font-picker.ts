import { htmlElement } from "../dom/html-element";
import {
  readerFontFamilyCss,
  READER_FONT_FAMILIES,
  READER_FONT_FAMILY_LABELS,
  type ReaderFontFamily,
} from "./settings-store";

interface BrowserLocalFontData {
  readonly family?: string;
}

interface LocalFontWindow extends Window {
  readonly queryLocalFonts?: () => Promise<readonly BrowserLocalFontData[]>;
}

export type LocalFontQuery = () => Promise<readonly string[]>;

export interface LocalFontOption {
  readonly family: string;
  readonly label: string;
  readonly searchText: string;
  readonly chinesePreferred: boolean;
}

const CHINESE_FONT_LABELS = Object.freeze<Record<string, string>>({
  "alibaba puhuiti": "阿里巴巴普惠体",
  dengxian: "等线",
  fangsong: "仿宋",
  "harmonyos sans sc": "鸿蒙黑体",
  "heiti sc": "黑体-简",
  "heiti tc": "黑体-繁",
  "hiragino sans gb": "冬青黑体简体中文",
  kaiti: "楷体",
  "kaiti sc": "楷体-简",
  "kaiti tc": "楷体-繁",
  "lxgw wenkai": "霞鹜文楷",
  "microsoft jhenghei": "微软正黑体",
  "microsoft jhenghei ui": "微软正黑体 UI",
  "microsoft yahei": "微软雅黑",
  "microsoft yahei ui": "微软雅黑 UI",
  "noto sans cjk sc": "思源黑体",
  "noto sans cjk tc": "思源黑体繁体",
  "noto serif cjk sc": "思源宋体",
  "noto serif cjk tc": "思源宋体繁体",
  nsimsun: "新宋体",
  "pingfang hk": "苹方-港",
  "pingfang sc": "苹方-简",
  "pingfang tc": "苹方-繁",
  simfang: "仿宋",
  simhei: "黑体",
  simkai: "楷体",
  simsun: "宋体",
  "smiley sans": "得意黑",
  "songti sc": "宋体-简",
  "songti tc": "宋体-繁",
  "source han sans sc": "思源黑体",
  "source han sans tc": "思源黑体繁体",
  "source han serif sc": "思源宋体",
  "source han serif tc": "思源宋体繁体",
  stfangsong: "华文仿宋",
  stheiti: "华文黑体",
  stkaiti: "华文楷体",
  stsong: "华文宋体",
  "wenquanyi micro hei": "文泉驿微米黑",
  "wenquanyi zen hei": "文泉驿正黑",
});

const CHINESE_FONT_HINT = /(?:\p{Script=Han}|cjk|source han|yahei|jhenghei|simsun|simhei|simkai|simfang|dengxian|pingfang|songti|heiti|kaiti|wenquanyi|wenkai|puhui|harmonyos)/iu;
const FONT_COLLATOR = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });
let localFontListId = 0;

function normalizedSearchText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("zh-CN").replace(/[\s()（）._-]+/gu, " ").trim();
}

export function buildLocalFontOptions(families: readonly string[]): readonly LocalFontOption[] {
  const unique = new Map<string, string>();
  for (const value of families) {
    const family = value.replace(/\s+/gu, " ").trim();
    if (!family) continue;
    const identity = family.toLocaleLowerCase("en-US");
    if (!unique.has(identity)) unique.set(identity, family);
  }
  const options = [...unique.values()].map((family): LocalFontOption => {
    const chineseName = CHINESE_FONT_LABELS[family.toLocaleLowerCase("en-US")];
    const label = chineseName ? `${chineseName}（${family}）` : family;
    return Object.freeze({
      family,
      label,
      searchText: normalizedSearchText(`${label} ${family}`),
      chinesePreferred: Boolean(chineseName) || CHINESE_FONT_HINT.test(family),
    });
  });
  options.sort((left, right) => Number(right.chinesePreferred) - Number(left.chinesePreferred)
    || FONT_COLLATOR.compare(left.label, right.label));
  return Object.freeze(options);
}

export function createBrowserLocalFontQuery(document: Document): LocalFontQuery | undefined {
  const browserWindow = document.defaultView as LocalFontWindow | null;
  let nativeQuery: LocalFontWindow["queryLocalFonts"];
  try {
    nativeQuery = browserWindow?.queryLocalFonts;
  } catch {
    return undefined;
  }
  if (!browserWindow || typeof nativeQuery !== "function") return undefined;
  let resolved: readonly string[] | null = null;
  let pending: Promise<readonly string[]> | null = null;
  return async () => {
    if (resolved) return resolved;
    if (pending) return pending;
    pending = Promise.resolve(Reflect.apply(nativeQuery, browserWindow, []))
      .then((entries) => Object.freeze(buildLocalFontOptions(entries.map((entry) => entry.family ?? ""))
        .map((entry) => entry.family)))
      .then((families) => {
        resolved = families;
        return families;
      });
    try {
      return await pending;
    } finally {
      pending = null;
    }
  };
}

interface FontChoice {
  readonly key: string;
  readonly fontFamily: ReaderFontFamily;
  readonly customFontFamily: string;
  readonly label: string;
  readonly searchText: string;
  readonly source: "preset" | "local" | "manual";
}

export interface LocalFontPickerOptions {
  readonly document: Document;
  readonly fontFamily: ReaderFontFamily;
  readonly customFontFamily: string;
  readonly fontFamilyName?: string;
  readonly customFontFamilyName?: string;
  readonly queryLocalFonts: LocalFontQuery | undefined;
}

export class LocalFontPicker {
  readonly element: HTMLElement;
  readonly fontFamilyInput: HTMLInputElement;
  readonly customFontFamilyInput: HTMLInputElement;
  readonly #document: Document;
  readonly #queryLocalFonts: LocalFontQuery | undefined;
  readonly #trigger: HTMLButtonElement;
  readonly #selectedLabel: HTMLElement;
  readonly #popover: HTMLElement;
  readonly #search: HTMLInputElement;
  readonly #list: HTMLElement;
  readonly #status: HTMLElement;
  #localOptions: readonly LocalFontOption[] = Object.freeze([]);
  #loading = false;
  #loaded = false;
  #queryEpoch = 0;

  constructor(options: LocalFontPickerOptions) {
    this.#document = options.document;
    this.#queryLocalFonts = options.queryLocalFonts;
    this.element = htmlElement(options.document, "span", "hnr-local-font-picker");
    this.fontFamilyInput = htmlElement(options.document, "input");
    this.fontFamilyInput.type = "hidden";
    this.fontFamilyInput.name = options.fontFamilyName ?? "fontFamily";
    this.fontFamilyInput.value = options.fontFamily;
    this.customFontFamilyInput = htmlElement(options.document, "input");
    this.customFontFamilyInput.type = "hidden";
    this.customFontFamilyInput.name = options.customFontFamilyName ?? "customFontFamily";
    this.customFontFamilyInput.value = options.customFontFamily;

    this.#trigger = htmlElement(options.document, "button", "hnr-local-font-trigger");
    this.#trigger.type = "button";
    this.#trigger.setAttribute("aria-haspopup", "listbox");
    this.#trigger.setAttribute("aria-expanded", "false");
    this.#selectedLabel = htmlElement(options.document, "span", "hnr-local-font-selected");
    const chevron = htmlElement(options.document, "span", "hnr-local-font-chevron", "⌄");
    chevron.setAttribute("aria-hidden", "true");
    this.#trigger.append(this.#selectedLabel, chevron);

    this.#popover = htmlElement(options.document, "span", "hnr-local-font-popover");
    this.#popover.hidden = true;
    const searchLabel = htmlElement(options.document, "label", "hnr-local-font-search");
    this.#search = htmlElement(options.document, "input");
    this.#search.type = "search";
    this.#search.placeholder = "搜索本机字体…";
    this.#search.autocomplete = "off";
    this.#search.setAttribute("aria-label", "搜索本机字体");
    this.#search.setAttribute("role", "combobox");
    this.#search.setAttribute("aria-autocomplete", "list");
    this.#search.setAttribute("aria-expanded", "true");
    searchLabel.append(this.#search);
    this.#list = htmlElement(options.document, "span", "hnr-local-font-list");
    this.#list.id = `hnr-local-font-list-${++localFontListId}`;
    this.#list.setAttribute("role", "listbox");
    this.#list.setAttribute("aria-label", "可用字体");
    this.#search.setAttribute("aria-controls", this.#list.id);
    this.#status = htmlElement(options.document, "span", "hnr-local-font-status");
    this.#status.setAttribute("role", "status");
    this.#status.setAttribute("aria-live", "polite");
    this.#popover.append(searchLabel, this.#list);
    this.element.append(
      this.fontFamilyInput,
      this.customFontFamilyInput,
      this.#trigger,
      this.#popover,
      this.#status,
    );

    this.#trigger.addEventListener("click", () => {
      if (this.#popover.hidden) this.open();
      else this.close();
    });
    this.#search.addEventListener("input", () => this.#renderOptions());
    this.#search.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown") return;
      this.#visibleButtons()[0]?.focus();
      event.preventDefault();
    });
    this.#list.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const buttons = this.#visibleButtons();
      const current = buttons.indexOf(this.#document.activeElement as HTMLButtonElement);
      const offset = event.key === "ArrowDown" ? 1 : -1;
      buttons[(current + offset + buttons.length) % buttons.length]?.focus();
      event.preventDefault();
    });
    this.#renderOptions();
    this.#syncSelection();
    this.#setStatus(this.#queryLocalFonts
      ? "进入字体设置后自动读取浏览器可用字体。"
      : "当前浏览器未开放本机字体列表；仍可搜索后手动使用字体名称。");
  }

  get expanded(): boolean {
    return !this.#popover.hidden;
  }

  activate(): void {
    if (this.#loaded || this.#loading || !this.#queryLocalFonts) return;
    void this.#loadLocalFonts();
  }

  open(): void {
    this.#popover.hidden = false;
    this.#trigger.setAttribute("aria-expanded", "true");
    this.#search.value = "";
    this.#renderOptions();
    this.#search.focus();
  }

  close(restoreFocus = false): void {
    this.#popover.hidden = true;
    this.#trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) this.#trigger.focus();
  }

  handleEscape(): boolean {
    if (!this.expanded) return false;
    this.close(true);
    return true;
  }

  containsEvent(event: Event): boolean {
    return event.composedPath().includes(this.element);
  }

  destroy(): void {
    this.#queryEpoch += 1;
    this.close();
  }

  #presetChoices(): readonly FontChoice[] {
    return READER_FONT_FAMILIES.filter((family) => family !== "custom").map((family) => ({
      key: `preset:${family}`,
      fontFamily: family,
      customFontFamily: "",
      label: READER_FONT_FAMILY_LABELS[family],
      searchText: normalizedSearchText(`${READER_FONT_FAMILY_LABELS[family]} ${family}`),
      source: "preset",
    }));
  }

  #localChoices(): readonly FontChoice[] {
    const choices = this.#localOptions.map((option): FontChoice => ({
      key: `local:${option.family}`,
      fontFamily: "custom",
      customFontFamily: option.family,
      label: option.label,
      searchText: option.searchText,
      source: "local",
    }));
    const selected = this.customFontFamilyInput.value.trim();
    if (this.fontFamilyInput.value === "custom" && selected
      && !choices.some((choice) => choice.customFontFamily === selected)) {
      const option = buildLocalFontOptions([selected])[0];
      if (option) choices.unshift({
        key: `local:${selected}`,
        fontFamily: "custom",
        customFontFamily: selected,
        label: option.label,
        searchText: option.searchText,
        source: "local",
      });
    }
    return choices;
  }

  #renderOptions(): void {
    const query = normalizedSearchText(this.#search.value);
    const presetChoices = this.#presetChoices().filter((choice) => !query || choice.searchText.includes(query));
    const localChoices = this.#localChoices().filter((choice) => !query || choice.searchText.includes(query));
    this.#list.replaceChildren();
    this.#appendGroup("预设字体", presetChoices);
    this.#appendGroup(this.#loaded ? `本机字体 · ${this.#localOptions.length}` : "本机字体", localChoices);
    if (presetChoices.length + localChoices.length === 0 && query) {
      const manualFamily = this.#search.value.replace(/\s+/gu, " ").trim().slice(0, 64);
      if (manualFamily) {
        const manualChoice: FontChoice = {
          key: `manual:${manualFamily}`,
          fontFamily: "custom",
          customFontFamily: manualFamily,
          label: `使用“${manualFamily}”`,
          searchText: query,
          source: "manual",
        };
        this.#appendGroup("手动字体名称", [manualChoice]);
      }
    }
  }

  #appendGroup(label: string, choices: readonly FontChoice[]): void {
    if (choices.length === 0) return;
    const group = htmlElement(this.#document, "span", "hnr-local-font-group");
    group.setAttribute("role", "group");
    group.setAttribute("aria-label", label);
    group.append(htmlElement(this.#document, "span", "hnr-local-font-group-label", label));
    for (const choice of choices) {
      const button = htmlElement(this.#document, "button", "hnr-local-font-option");
      button.type = "button";
      button.dataset.fontKey = choice.key;
      button.dataset.fontFamily = choice.fontFamily;
      button.dataset.fontName = choice.customFontFamily;
      button.dataset.fontSource = choice.source;
      button.setAttribute("role", "option");
      const selected = choice.fontFamily === this.fontFamilyInput.value
        && (choice.fontFamily !== "custom" || choice.customFontFamily === this.customFontFamilyInput.value);
      button.setAttribute("aria-selected", String(selected));
      const labelElement = htmlElement(this.#document, "span", "hnr-local-font-option-label", choice.label);
      const sample = htmlElement(this.#document, "span", "hnr-local-font-option-sample", "中文预览 · Aa 0123");
      sample.lang = "zh-CN";
      sample.style.fontFamily = readerFontFamilyCss(choice.fontFamily, choice.customFontFamily);
      button.append(labelElement, sample);
      button.addEventListener("click", () => this.#select(choice));
      group.append(button);
    }
    this.#list.append(group);
  }

  #select(choice: FontChoice): void {
    this.fontFamilyInput.value = choice.fontFamily;
    this.customFontFamilyInput.value = choice.customFontFamily;
    this.#syncSelection();
    this.close(true);
    const EventConstructor = this.#document.defaultView?.Event ?? Event;
    this.fontFamilyInput.dispatchEvent(new EventConstructor("change", { bubbles: true }));
  }

  #syncSelection(): void {
    const family = this.fontFamilyInput.value as ReaderFontFamily;
    if (family !== "custom") {
      this.#selectedLabel.textContent = READER_FONT_FAMILY_LABELS[family] ?? READER_FONT_FAMILY_LABELS.system;
      this.#selectedLabel.style.fontFamily = readerFontFamilyCss(family);
      return;
    }
    const selected = this.customFontFamilyInput.value.trim();
    const option = buildLocalFontOptions([selected])[0];
    this.#selectedLabel.textContent = option?.label ?? READER_FONT_FAMILY_LABELS.custom;
    this.#selectedLabel.style.fontFamily = readerFontFamilyCss("custom", selected);
  }

  #visibleButtons(): HTMLButtonElement[] {
    return [...this.#list.querySelectorAll<HTMLButtonElement>(".hnr-local-font-option")];
  }

  async #loadLocalFonts(): Promise<void> {
    if (!this.#queryLocalFonts || this.#loading) return;
    const epoch = ++this.#queryEpoch;
    this.#loading = true;
    this.#setStatus("正在请求浏览器本机字体权限…");
    try {
      this.#localOptions = buildLocalFontOptions(await this.#queryLocalFonts());
      if (epoch !== this.#queryEpoch) return;
      this.#loaded = true;
      this.#renderOptions();
      this.#syncSelection();
      this.#setStatus(this.#localOptions.length > 0
        ? `已读取 ${this.#localOptions.length} 个本机字体；中文字体已优先排列。`
        : "浏览器未返回可用本机字体。");
    } catch {
      if (epoch !== this.#queryEpoch) return;
      this.#setStatus("未获得本机字体权限；可重试或直接搜索并手动使用字体名称。", true);
    } finally {
      if (epoch === this.#queryEpoch) this.#loading = false;
    }
  }

  #setStatus(message: string, retry = false): void {
    this.#status.replaceChildren(this.#document.createTextNode(message));
    if (!retry) return;
    const button = htmlElement(this.#document, "button", "hnr-local-font-retry", "重试");
    button.type = "button";
    button.addEventListener("click", () => { void this.#loadLocalFonts(); });
    this.#status.append(" ", button);
  }
}
