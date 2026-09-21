export type VocabularyLevel = "CET6" | "CET6+";

export interface VocabularyWord {
  readonly word: string;
  readonly ipa: string;
  readonly meaning: string;
  readonly example: string;
  readonly exampleMeaning: string;
  readonly level: VocabularyLevel;
}

export const VOCABULARY_MAX_WORDS = 6;
export const VOCABULARY_MAX_SOURCE_CHARS = 3_000;
const VERBATIM_LEVELS: readonly VocabularyLevel[] = Object.freeze(["CET6", "CET6+"]);
const WORD_PATTERN = /^[a-z]+(?:[-'][a-z]+)*$/i;
const CJK_PATTERN = /\p{Script=Han}/u;
const LETTER_PATTERN = /[a-z]+(?:[-'][a-z]+)*/gi;

function boundedText(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maximum ? trimmed : undefined;
}

function levelOf(value: unknown): VocabularyLevel | undefined {
  return VERBATIM_LEVELS.find((level) => level === value);
}

function normalizedExample(value: unknown, exampleMeaning: unknown): { example: string; exampleMeaning: string } | undefined {
  const example = boundedText(value, 500);
  const meaning = boundedText(exampleMeaning, 800);
  return example && meaning ? { example, exampleMeaning: meaning } : undefined;
}

/**
 * Accepts only entries that can be rendered safely and truthfully: the word must be a plain
 * English lemma, the meaning must be Chinese, and the example must carry its own translation.
 */
export function normalizeVocabularyWord(value: unknown): VocabularyWord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  const word = boundedText(record.word, 40);
  const ipa = boundedText(record.ipa, 100);
  const meaning = boundedText(record.meaning, 200);
  const level = levelOf(record.level);
  const example = normalizedExample(record.example, record.exampleMeaning);
  if (!word || !WORD_PATTERN.test(word) || !ipa || !meaning || !level || !example) return;
  if (!CJK_PATTERN.test(meaning) || !CJK_PATTERN.test(example.exampleMeaning)) return;
  return Object.freeze({
    word: word.toLowerCase(),
    ipa,
    meaning,
    example: example.example,
    exampleMeaning: example.exampleMeaning,
    level,
  });
}

export function vocabularySourceText(source: string): string {
  return source.replace(/\s+/gu, " ").trim().slice(0, VOCABULARY_MAX_SOURCE_CHARS);
}

function sourceWords(source: string): ReadonlySet<string> {
  return new Set((source.toLowerCase().match(LETTER_PATTERN) ?? []).map((word) => word.toLowerCase()));
}

/**
 * Filters the model answer down to words that are actually present in the comment text, so the
 * reader never highlights or shows a word the source does not contain.
 */
export function normalizeVocabularyWords(value: unknown, source: string): readonly VocabularyWord[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const present = sourceWords(source);
  const accepted: VocabularyWord[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const word = normalizeVocabularyWord(entry);
    if (!word || seen.has(word.word) || !present.has(word.word)) continue;
    seen.add(word.word);
    accepted.push(word);
    if (accepted.length >= VOCABULARY_MAX_WORDS) break;
  }
  return Object.freeze(accepted);
}
