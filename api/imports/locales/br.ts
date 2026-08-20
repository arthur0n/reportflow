// api/imports/locales/br.ts
//
// Brazilian Portuguese locale helpers for bank statement parsing.
// Pure functions — no DB access, no side effects.

/**
 * Parse an amount string into signed integer cents.
 *
 * Accepts two formats — picked by the presence of a comma:
 *   - BR (user input / some CSVs):    "1.234,56"  "-350,00"  "+1.200,00"
 *   - Plain decimal (OFX / exports):  "2526.13"   "-3500.00" "100"
 *
 * Trailing `D` (debit) / `C` (credit) suffix is honored for OFX variants.
 */
export function parseAmountBR(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error("empty amount string");

  // Determine sign: leading minus, leading plus, or trailing D/C
  let sign = 1;
  let s = trimmed;

  if (s.startsWith("-")) {
    sign = -1;
    s = s.slice(1);
  } else if (s.startsWith("+")) {
    s = s.slice(1);
  }

  // Some OFX files use trailing D (debit) / C (credit)
  if (s.endsWith("D")) {
    sign = -1;
    s = s.slice(0, -1);
  } else if (s.endsWith("C")) {
    s = s.slice(0, -1);
  }

  // A comma signals BR format: dots are thousands, comma is decimal.
  // No comma → plain decimal; leave the dot alone.
  if (s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  }
  s = s.trim();

  const num = parseFloat(s);
  if (Number.isNaN(num)) throw new Error(`cannot parse amount: "${raw}"`);

  return sign * Math.round(num * 100);
}

/**
 * Parse OFX date format or BR dd/MM/yyyy into ISO date string.
 * OFX: "20240315120000[-3:GMT]" or "20240315" → "2024-03-15"
 * BR:  "15/03/2024" → "2024-03-15"
 */
export function parseDateBR(raw: string): string {
  const trimmed = raw.trim();

  // BR format: dd/MM/yyyy
  const brMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(trimmed);
  if (brMatch) {
    const [, dd, mm, yyyy] = brMatch;
    return `${yyyy}-${mm}-${dd}`;
  }

  // OFX format: YYYYMMDDhhmmss[offset] or YYYYMMDD
  const ofxMatch = /^(\d{4})(\d{2})(\d{2})/.exec(trimmed);
  if (ofxMatch) {
    const [, yyyy, mm, dd] = ofxMatch;
    return `${yyyy}-${mm}-${dd}`;
  }

  throw new Error(`cannot parse date: "${raw}"`);
}

/**
 * Normalize a BR bank statement description:
 * - Collapse whitespace
 * - Trim
 * - Decode common CP1252 remnants
 */
export function normalizeDescriptionBR(raw: string): string {
  let s = raw;

  // Common CP1252 → UTF-8 mangling in BR OFX
  s = s.replace(/\u00c3\u00a7/g, "ç");
  s = s.replace(/\u00c3\u00a3/g, "ã");
  s = s.replace(/\u00c3\u00a9/g, "é");
  s = s.replace(/\u00c3\u00ad/g, "í");
  s = s.replace(/\u00c3\u00b3/g, "ó");
  s = s.replace(/\u00c3\u00ba/g, "ú");

  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();

  return s;
}
