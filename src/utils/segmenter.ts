const SEGMENTER = new Intl.Segmenter("zh-Hans", { granularity: "word" });
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const QUERY_TOKEN_PATTERN = /[\p{Letter}\p{Number}_-]+/gu;

function normalizeWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

export function segmentForFts(text: string): string {
  const normalized = normalizeWhitespace(text);
  if (!normalized) {
    return "";
  }

  const tokens = [...SEGMENTER.segment(normalized)]
    .filter((segment) => segment.isWordLike)
    .map((segment) => segment.segment.trim())
    .filter(Boolean);

  return tokens.length > 0 ? tokens.join(" ") : normalized;
}

export function normalizeFtsQuery(query: string): string {
  const normalized = normalizeWhitespace(query);
  if (!normalized) {
    return "";
  }

  return normalized.replace(QUERY_TOKEN_PATTERN, (token) =>
    CJK_PATTERN.test(token) ? segmentForFts(token) : token,
  );
}
