/**
 * Money is a string on the page and an integer in the code. Never a float.
 *
 * The model returns "1.234,56 €" verbatim. We parse it to 123456 cents here,
 * deterministically, with no floating-point arithmetic anywhere in the path.
 * Sums are integer sums. Formatting back out is pure string assembly.
 *
 * Why this matters for the POC's core claim: a number rendered in the report is
 * byte-identical to the number on the invoice, and every derived total is a sum
 * of integers a human can re-add by hand.
 */

/**
 * "1.234,56 €" -> 123456, and "1 234,56 euros" -> 123456.
 *
 * Both renderings occur in this corpus: the invoices use a dot separator and the
 * € sign, the contract spells the currency out and separates thousands with a
 * space. Same amount, two typographies — so the parse tolerates both and the
 * ARITHMETIC is identical either way. Throws on anything it cannot read exactly;
 * a silent zero here would be a wrong number on a client's document.
 */
export function parseEuroToCents(verbatim: string): number {
  // Order matters. Strip the currency word/symbol, then every whitespace form,
  // then the thousands separator. The decimal separator is always the comma in
  // this locale, so removing all dots cannot destroy a fractional part.
  const cleaned = verbatim
    .replace(/[\u00a0\u202f\u2009]/gu, " ")
    .replace(/\s*(?:\u20ac|euros?)\s*$/iu, "")
    .replace(/\s/gu, "")
    .replace(/\./gu, "");
  const match = /^(-?)(\d+),(\d{2})$/u.exec(cleaned);
  if (!match) throw new Error(`não é moeda europeia reconhecível: ${JSON.stringify(verbatim)}`);
  const [, sign = "", whole = "", frac = ""] = match;
  const units = Number.parseInt(whole, 10);
  const cents = Number.parseInt(frac, 10);
  const total = units * 100 + cents;
  return sign === "-" ? -total : total;
}

/** 123456 -> "1.234,56 €". The `money` Handlebars helper. */
export function formatCents(cents: number): string {
  if (!Number.isInteger(cents))
    throw new Error(`formatCents espera inteiro, recebeu ${String(cents)}`);
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const units = Math.trunc(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  const grouped = String(units).replace(/\B(?=(\d{3})+(?!\d))/gu, ".");
  return `${negative ? "-" : ""}${grouped},${frac} €`;
}

export function sumCents(values: readonly number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

/* ---------------------------------------------------------------- */

/** "28/02/2025" -> a sortable key. Dates stay strings; this is for ordering. */
export function dateKey(ddmmyyyy: string): number {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/u.exec(ddmmyyyy);
  if (!m) throw new Error(`data inválida: ${ddmmyyyy}`);
  const [, d = "", mo = "", y = ""] = m;
  return Number.parseInt(`${y}${mo}${d}`, 10);
}

/** The `date` Handlebars helper. Input is already dd/mm/yyyy; this validates. */
export function formatDate(ddmmyyyy: string): string {
  dateKey(ddmmyyyy);
  return ddmmyyyy;
}

const MESES = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
] as const;

export function monthLabel(ddmmyyyy: string): string {
  const m = /^\d{2}\/(\d{2})\/(\d{4})$/u.exec(ddmmyyyy);
  if (!m) throw new Error(`data inválida: ${ddmmyyyy}`);
  const [, mo = "", y = ""] = m;
  const name = MESES[Number.parseInt(mo, 10) - 1];
  if (name === undefined) throw new Error(`mês inválido: ${mo}`);
  return `${name} de ${y}`;
}
