// Reading time for mixed scripts: CJK has no word spaces, so its characters are counted
// on their own (about 400 a minute), everything else by whitespace-separated words.
const WORDS_PER_MINUTE = 240;
const CJK_CHARS_PER_MINUTE = 400;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
// Full-width punctuation (。，！？「」…) is script Common, so it must be dropped on its own or it becomes phantom words.
const CJK_PUNCTUATION = /[\u2000-\u206f\u3000-\u303f\uff00-\uffef]/g;

/** Whitespace-separated words plus one "word" per CJK character. */
export function wordCount(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  const rest = text.replace(CJK_PUNCTUATION, " ").replace(CJK, " ").trim().split(/\s+/).filter(Boolean).length;
  return rest + cjk;
}

export function readingMinutes(text: string): number {
  const cjk = text.match(CJK)?.length ?? 0;
  const words = text.replace(CJK_PUNCTUATION, " ").replace(CJK, " ").trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / WORDS_PER_MINUTE + cjk / CJK_CHARS_PER_MINUTE));
}
