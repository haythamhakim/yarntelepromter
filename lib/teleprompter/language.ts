const LATIN_LETTER_REGEX = /\p{Script=Latin}/gu;
const CYRILLIC_LETTER_REGEX = /\p{Script=Cyrillic}/gu;
const ARABIC_LETTER_REGEX = /\p{Script=Arabic}/gu;
const DEVANAGARI_LETTER_REGEX = /\p{Script=Devanagari}/gu;
const HEBREW_LETTER_REGEX = /\p{Script=Hebrew}/gu;
const GREEK_LETTER_REGEX = /\p{Script=Greek}/gu;
const THAI_LETTER_REGEX = /\p{Script=Thai}/gu;
const HANGUL_LETTER_REGEX = /\p{Script=Hangul}/gu;
const HIRAGANA_KATAKANA_REGEX = /[\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const HAN_REGEX = /\p{Script=Han}/gu;

function countMatches(input: string, regex: RegExp): number {
  const matches = input.match(regex);
  return matches?.length ?? 0;
}

/**
 * Best-effort language hint for realtime transcription.
 * This is script-based, so Latin text defaults to English.
 */
export function inferScriptLanguageCode(scriptText: string): string {
  const text = scriptText.trim();
  if (!text) {
    return "en";
  }

  const scriptCounts = [
    { code: "ja", count: countMatches(text, HIRAGANA_KATAKANA_REGEX) },
    { code: "ko", count: countMatches(text, HANGUL_LETTER_REGEX) },
    { code: "zh", count: countMatches(text, HAN_REGEX) },
    { code: "ar", count: countMatches(text, ARABIC_LETTER_REGEX) },
    { code: "hi", count: countMatches(text, DEVANAGARI_LETTER_REGEX) },
    { code: "he", count: countMatches(text, HEBREW_LETTER_REGEX) },
    { code: "th", count: countMatches(text, THAI_LETTER_REGEX) },
    { code: "ru", count: countMatches(text, CYRILLIC_LETTER_REGEX) },
    { code: "el", count: countMatches(text, GREEK_LETTER_REGEX) },
    { code: "en", count: countMatches(text, LATIN_LETTER_REGEX) },
  ];

  const best = scriptCounts.reduce((currentBest, candidate) =>
    candidate.count > currentBest.count ? candidate : currentBest,
  );

  return best.count > 0 ? best.code : "en";
}
