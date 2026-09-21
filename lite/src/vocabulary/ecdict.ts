import { ecdictData } from "./ecdict-data";

export interface LocalWord {
  readonly word: string;
  readonly ipa: string;
  readonly meaning: string;
  readonly tags: readonly string[];
  readonly exchange: string;
  readonly pos: string;
}

let database: Promise<Map<string, LocalWord>> | undefined;

/** ECDICT labels to the exam names the reader recognises, mirroring the reference userscript. */
export const WORD_TAG_LABELS: Readonly<Record<string, string>> = Object.freeze({
  cet4: "CET4",
  cet6: "CET6",
  zk: "中考",
  gk: "高考",
  ky: "考研",
  ielts: "IELTS",
  toefl: "TOEFL",
  gre: "GRE",
});

/** ECDICT exchange codes to Chinese form names, mirroring the reference userscript. */
export const WORD_FORM_LABELS: Readonly<Record<string, string>> = Object.freeze({
  p: "过去式",
  d: "过去分词",
  i: "现在分词",
  "3": "第三人称",
  s: "复数",
  r: "比较级",
  t: "最高级",
  0: "原形",
});

/**
 * The word list ships gzipped to keep the userscript small; it is inflated once per session, on the
 * first word the reader opens, rather than at start-up.
 */
export async function localWord(word: string): Promise<LocalWord | undefined> {
  database ??= (async () => {
    const bytes = Uint8Array.from(atob(ecdictData), (character) => character.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    const rows = JSON.parse(await new Response(stream).text()) as string[][];
    return new Map(rows.map((row) => {
      const [entry = "", ipa = "", meaning = "", tags = "", exchange = "", pos = ""] = row;
      return [entry.toLowerCase(), Object.freeze({
        word: entry,
        ipa,
        meaning,
        tags: Object.freeze(tags.split(" ").filter(Boolean)),
        exchange,
        pos,
      })];
    }));
  })();
  return (await database).get(word.trim().toLowerCase());
}

/** Word forms such as `p:went/d:gone`, translated for display. */
export function wordFormParts(exchange: string): readonly string[] {
  return Object.freeze(exchange.split("/").flatMap((value) => {
    const [key, form] = value.split(":");
    const label = key === undefined ? undefined : WORD_FORM_LABELS[key];
    return label && form ? [`${label} ${form}`] : [];
  }));
}

export function wordTagLabels(tags: readonly string[]): readonly string[] {
  return Object.freeze(tags.map((tag) => WORD_TAG_LABELS[tag] ?? tag));
}
