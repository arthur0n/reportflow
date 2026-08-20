// Strips known boilerplate prefixes (PIX ENVIADO, TED ENVIADA, ...) from a
// statement-row description so the imports review screen can pre-fill the
// quick-create dialog with a likely supplier/customer name. Phrases come from
// the DESCRIPTION_NOISE system LOV. Prefix-only, accent-insensitive.
//
// Input: raw description from statement_import_lines.description plus the list
// of phrases (LOV values, original casing).
// Output: trimmed remainder; "" if the whole description was noise or empty.

const DIACRITIC_RE = /\p{Diacritic}/gu;

function fold(s: string): string {
  return s.normalize("NFKD").replace(DIACRITIC_RE, "").toLowerCase();
}

export function cleanDescriptionForCreate(
  description: string,
  noisePhrases: readonly string[],
): string {
  let out = description.replace(/\s+/gu, " ").trim();
  if (out === "" || noisePhrases.length === 0) return out;

  const phrases = [...noisePhrases]
    .map((p) => p.replace(/\s+/gu, " ").trim())
    .filter((p) => p.length > 0)
    .sort((a, b) => b.length - a.length);

  let changed = true;
  while (changed) {
    changed = false;
    const folded = fold(out);
    for (const phrase of phrases) {
      const f = fold(phrase);
      if (folded.startsWith(f) && (out.length === f.length || /\s/u.test(out[f.length] ?? ""))) {
        out = out.slice(f.length).trimStart();
        changed = true;
        break;
      }
    }
  }
  return out;
}
