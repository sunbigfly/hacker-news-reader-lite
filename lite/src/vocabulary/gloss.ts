/**
 * Matches a word's Chinese gloss against the Chinese text the reader is looking at.
 *
 * Ported from the reference userscript's `wordbook-chinese.ts`, minus its `opencc-js` dependency: our
 * Chinese comes from the reader's own translation, which is already Simplified, so no script
 * conversion is needed.
 *
 * Unlike the reference, the gloss and the sentence come from **different** requests — the AI writes the
 * gloss, the translation service writes the sentence — so they never share wording exactly. The
 * reference could match a gloss verbatim because one call produced both; here a gloss such as
 * 「难以接近的」 must still find 「难以接近」 inside the sentence. Matching therefore walks down from
 * the longest run the two share, and glosses stay candidates, never a claimed word-for-word alignment.
 */

const PARENTHETICAL = /[（(][^）)]*[）)]/gu;
const HAN_RUN = /\p{Script=Han}{2,}/gu;
const TRAILING_PARTICLES = /[的了着地得]+$/u;
const MIN_TERM_LENGTH = 2;

/** One span per word: a second mark reads as noise rather than as the same word again. */
const MAX_TERMS_PER_WORD = 1;

/** Han runs of a Chinese gloss, with explanatory parentheticals removed. */
export function glossRuns(meaning: string): readonly string[] {
  return Object.freeze(meaning.replace(PARENTHETICAL, " ").match(HAN_RUN) ?? []);
}

/**
 * The spans of one gloss phrase that touch either end of it, longest first: the phrase without its
 * trailing particle, then its prefixes and its suffixes. Anchoring this way is what keeps a claim from
 * straddling two words — 「可交换使用地」 must not claim the meaningless 「换使用」 that happens to lie
 * between 「互换」 and 「使用」 in the sentence.
 */
function boundarySpans(run: string): readonly string[] {
  const phrase = run.replace(TRAILING_PARTICLES, "");
  const spans: string[] = [];
  for (let length = phrase.length; length >= MIN_TERM_LENGTH; length -= 1) {
    spans.push(phrase.slice(0, length));
    if (length < phrase.length) spans.push(phrase.slice(-length));
  }
  return spans;
}

/** The anchored spans of one run that the sentence also contains. */
function sharedSpans(run: string, chinese: string): readonly string[] {
  return boundarySpans(run).filter((span) => chinese.includes(span));
}

/**
 * The span of `chinese` that `meaning` claims: the one appearing **earliest** in the sentence, with the
 * longer of two spans starting at the same place winning.
 *
 * Position comes first because a later, longer overlap is usually two neighbouring words rather than
 * the gloss itself — 「可互换地」 and 「可交换使用地」 both describe 「互换」 in 「可以互换使用」, yet the
 * longest shared slice there is the meaningless 「换使用」 straddling 「互换|使用」. Anchoring to the
 * earliest occurrence also settles competing gloss runs: against 「难以接近」, the first run's 「难以」 is
 * the one that loses.
 */
export function glossTerms(meaning: string, chinese: string): readonly string[] {
  if (chinese.length === 0) return Object.freeze([]);
  const candidates = [...new Set(glossRuns(meaning).flatMap((run) => sharedSpans(run, chinese)))]
    .map((span) => ({ span, at: chinese.indexOf(span) }))
    .sort((left, right) => left.at - right.at || right.span.length - left.span.length);
  // A candidate nested inside another one is the same claim, so it is never marked twice.
  return Object.freeze(candidates
    .filter((candidate) => !candidates.some((other) => other !== candidate && other.span.includes(candidate.span)))
    .slice(0, MAX_TERMS_PER_WORD)
    .map((candidate) => candidate.span));
}

/** The pattern that marks the found spans, or null when the gloss shares nothing with the sentence. */
export function glossPattern(meaning: string, chinese: string): RegExp | null {
  const terms = glossTerms(meaning, chinese);
  if (terms.length === 0) return null;
  return new RegExp(terms.map(escapePattern).join("|"), "gu");
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
