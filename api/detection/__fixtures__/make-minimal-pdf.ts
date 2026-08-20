// api/detection/__fixtures__/make-minimal-pdf.ts
//
// A tiny, HAND-BUILT single-page PDF generator for tests — no library, no
// binary committed to the repo. Real client documents (pdf/*.pdf at the repo
// root) must never be committed as test fixtures; this generates a synthetic
// one on the fly, with real pt-BR text INCLUDING accents, so
// page-text.test.ts and detect.test.ts can prove diacritic handling without
// a single byte of anyone's real invoice.
//
// Deliberately raw PDF syntax (one page, one Type1/Helvetica font, one
// content stream) rather than a PDF-authoring dependency — the whole point is
// that a test fixture needs no new package. WinAnsiEncoding is set
// EXPLICITLY on the font: pdf.js (and most viewers) fall back to
// StandardEncoding without it, which has no code point for "Ç" or "Ã" — an
// omission here would silently strip exactly the characters this fixture
// exists to test.

/** Encodes to Latin-1/WinAnsi bytes — a match for the accented Portuguese
 * characters ("Ç", "Ã", "É", …) this fixture uses; NOT a general Unicode
 * encoder. */
function toWinAnsiBytes(str: string): Buffer {
  const bytes: number[] = [];
  for (const ch of str) {
    bytes.push((ch.codePointAt(0) ?? 0x3f) & 0xff);
  }
  return Buffer.from(bytes);
}

/** PDF string-literal escaping for the three characters that are otherwise
 * special inside `( … )`. */
function pdfEscape(latin1: string): string {
  return latin1.replace(/([()\\])/gu, "\\$1");
}

/**
 * Builds a minimal one-page PDF whose page-1 text is exactly `lines`, one
 * per text-showing operator, top to bottom.
 *
 * `lines: []` builds a page with NO text-drawing operators at all — the
 * "scanned document, no text layer" case §12.2 requires tier 1 to skip
 * rather than fail on.
 */
export function buildMinimalPdf(lines: readonly string[]): Buffer {
  const contentLines = lines
    .map((line, i) => {
      const y = 700 - i * 20;
      const escaped = pdfEscape(toWinAnsiBytes(line).toString("latin1"));
      return `BT /F1 14 Tf 72 ${String(y)} Td (${escaped}) Tj ET`;
    })
    .join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];

  const streamBytes = Buffer.from(contentLines, "latin1");
  const streamObj = Buffer.concat([
    Buffer.from(`5 0 obj\n<< /Length ${String(streamBytes.length)} >>\nstream\n`, "latin1"),
    streamBytes,
    Buffer.from("\nendstream\nendobj\n", "latin1"),
  ]);

  let pdf = Buffer.from("%PDF-1.4\n", "latin1");
  const offsets: number[] = [0];
  for (const [i, obj] of objects.entries()) {
    offsets.push(pdf.length);
    pdf = Buffer.concat([pdf, Buffer.from(`${String(i + 1)} 0 obj\n${obj}\nendobj\n`, "latin1")]);
  }
  offsets.push(pdf.length);
  pdf = Buffer.concat([pdf, streamObj]);

  const xrefOffset = pdf.length;
  const totalObjects = objects.length + 2; // + the stream object + object 0
  let xref = `xref\n0 ${String(totalObjects)}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  const streamOffset = offsets[objects.length + 1];
  xref += `${String(streamOffset).padStart(10, "0")} 00000 n \n`;

  const trailer = `trailer\n<< /Size ${String(totalObjects)} /Root 1 0 R >>\nstartxref\n${String(xrefOffset)}\n%%EOF`;

  return Buffer.concat([pdf, Buffer.from(xref + trailer, "latin1")]);
}
