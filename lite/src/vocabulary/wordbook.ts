import { normalizeVocabularyWord, type VocabularyWord } from "./model";

export interface SavedWord extends VocabularyWord {
  readonly sourceUrl: string;
  readonly addedAt: number;
}

export interface WordbookStorage {
  readonly read: (key: string, fallback: unknown) => unknown;
  readonly write: (key: string, value: unknown) => void;
}

export const WORDBOOK_STORAGE_KEY = "hn-reader:wordbook:v1";
export const WORDBOOK_MAX_WORDS = 500;

function defaultStorage(): WordbookStorage | undefined {
  if (typeof GM_getValue !== "function" || typeof GM_setValue !== "function") return undefined;
  return {
    read: (key, fallback) => GM_getValue<unknown>(key, fallback),
    write: (key, value) => GM_setValue(key, value),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function savedWord(value: unknown): SavedWord | undefined {
  if (!isRecord(value)) return;
  const word = normalizeVocabularyWord(value);
  const sourceUrl = typeof value.sourceUrl === "string" && /^https?:/u.test(value.sourceUrl) ? value.sourceUrl : undefined;
  const addedAt = typeof value.addedAt === "number" && Number.isFinite(value.addedAt) ? value.addedAt : undefined;
  return word && sourceUrl !== undefined && addedAt !== undefined
    ? Object.freeze({ ...word, sourceUrl, addedAt })
    : undefined;
}

/** Unreadable storage, foreign shapes and stale entries all collapse to an empty wordbook. */
export function readWordbook(storage: WordbookStorage | undefined = defaultStorage()): readonly SavedWord[] {
  if (!storage) return Object.freeze([]);
  let stored: unknown;
  try {
    stored = storage.read(WORDBOOK_STORAGE_KEY, []);
  } catch {
    return Object.freeze([]);
  }
  if (!Array.isArray(stored)) return Object.freeze([]);
  return Object.freeze(stored.flatMap((entry) => {
    const word = savedWord(entry);
    return word ? [word] : [];
  }));
}

export function findSavedWord(word: string, storage?: WordbookStorage): SavedWord | undefined {
  const normalized = word.trim().toLowerCase();
  return readWordbook(storage).find((entry) => entry.word === normalized);
}

export function addWord(
  word: VocabularyWord,
  sourceUrl: string,
  options: { readonly addedAt?: number; readonly storage?: WordbookStorage } = {},
): { readonly added: boolean; readonly total: number } {
  const storage = options.storage ?? defaultStorage();
  const book = readWordbook(storage);
  if (book.some((entry) => entry.word === word.word)) return Object.freeze({ added: false, total: book.length });
  if (book.length >= WORDBOOK_MAX_WORDS) throw new Error(`单词本已满（${WORDBOOK_MAX_WORDS} 词），请先移除一些单词。`);
  const entry = Object.freeze({ ...word, sourceUrl, addedAt: options.addedAt ?? Date.now() });
  storage?.write(WORDBOOK_STORAGE_KEY, Object.freeze([...book, entry]));
  return Object.freeze({ added: true, total: book.length + 1 });
}

export function removeWord(word: string, storage: WordbookStorage | undefined = defaultStorage()): boolean {
  const normalized = word.trim().toLowerCase();
  const book = readWordbook(storage);
  const next = book.filter((entry) => entry.word !== normalized);
  if (next.length === book.length) return false;
  storage?.write(WORDBOOK_STORAGE_KEY, next);
  return true;
}
