// Match normalization.
//
// Used as the keying form for LearnedDecisionMatcher (so "PIX OUT IFOOD 1234"
// and "pix out  ifood  9999" hash to the same lookup key). Distinct from
// shared/validation/slugify.ts: slugify produces hyphenated codes capped at
// 50 chars for LOV.code; this preserves spaces, drops bank-statement noise,
// and is non-injective by design.

const STRIP_PATTERNS: RegExp[] = [
  // BR transaction type prefixes — already classified by inferTransactionTypeBR.
  /\b(?:PIX|TED|DOC|BOLETO|TARIFA|TAXA|IOF|CARTAO|DEBITO|CREDITO)\s*(?:ENVIADO|RECEBIDO|OUT|IN|ENVIO|REC)?\b/gi,
  // Agency / account markers — "AG 0001", "AGENCIA 1234", "CC 12345-6", "CONTA 12345"
  /\b(?:AG|AGENCIA|CC|CONTA|OP)\s*\d[\d\s.\-/]*/gi,
  // Long digit runs (account/doc numbers, FITIDs).
  /\b\d{6,}\b/g,
  // BR date patterns DD/MM/YYYY or DD-MM-YYYY
  /\b\d{2}[/\-.]\d{2}[/\-.]\d{2,4}\b/g,
  // ISO date
  /\b\d{4}-\d{2}-\d{2}\b/g,
];

/**
 * Normalize a free-text description for match keying.
 *
 *  1. Unicode NFKD → strip combining marks (accents).
 *  2. Strip BR-specific noise (transaction type prefixes, account/agency markers, dates, long digit runs).
 *  3. Lowercase.
 *  4. Collapse whitespace.
 *  5. Trim.
 *
 * Returns "" on empty/whitespace-only input.
 */
export function normalizeForMatch(text: string | null | undefined): string {
  if (text === null || text === undefined) return "";
  let s = text.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  for (const re of STRIP_PATTERNS) s = s.replace(re, " ");
  s = s.toLowerCase().replace(/\s+/g, " ").trim();
  return s;
}
