// api/detection/page-text.ts
//
// Page-1 text extraction, done LOCALLY in the API Lambda (decisions §3.3,
// §12.2) — no internet, no relay hop, free. Feeds tier 1 of document type
// detection: a substring match against each tenant's `detect_hint`.
//
// LIBRARY SPIKE (2026-08-20). Candidates considered: `pdf-parse` (v2.4.5),
// `pdfjs-dist` (legacy build, used directly), `unpdf`. Chose **unpdf**.
//
//   * `pdf-parse` v2.4.5 is a full rewrite (nothing like the old 1.x API) and
//     depends on `@napi-rs/canvas`, a native (NAPI/Rust) addon. That is
//     disqualifying on its own: a native `.node` binary built for the wrong
//     platform/arch is exactly the class of failure `sam build`'s esbuild
//     step cannot catch at build time — it would only surface as a runtime
//     crash in Lambda. Confirmed present via
//     `node_modules/pdf-parse/package.json` → `dependencies["@napi-rs/canvas"]`.
//   * `pdfjs-dist` (legacy build, `pdfjs-dist/legacy/build/pdf.mjs`) is the
//     engine underneath both of the others and works, but using it directly
//     means owning DOMMatrix/canvas polyfills and the worker-vs-no-worker
//     wiring yourself — exactly the boilerplate `unpdf` exists to remove.
//   * `unpdf` wraps that same pdfjs-dist legacy build, purpose-built for
//     "serverless/edge" (its own README), ships a SINGLE bundled
//     `dist/pdfjs.mjs` with no native deps and no worker file to wire up, and
//     runs pdf.js on the main thread in Node by design.
//
// Verified with a throwaway esbuild probe (bundle+minify, --platform=node,
// the SAME `--external:pg-native,better-sqlite3,tedious,sqlite3,mysql,mysql2,
// pg-query-stream,oracledb` list this project's `template.yaml` already uses
// for both Lambdas): the bundle is self-contained (`grep -c "require("` → 0
// unresolved), ~1.5 MB minified in both `--format=esm` and `--format=cjs`
// (SAM's esbuild default), and correctly extracts page 1 of
// `pdf/FT_C2025_141.pdf` — accented text intact ("Administração de Imóveis",
// "Contribuinte", "Preço") — in both bundle formats. 1.5 MB is a rounding
// error against Lambda's 250 MB unzipped limit.
//
// unpdf's own text layout heuristic (`extractText`) is used rather than
// walking text-run items by hand: reconstructing reading order from raw
// glyph positions is exactly the kind of pdf.js-internals work `unpdf` exists
// to absorb, and detection only needs "does this substring appear somewhere
// on page 1", not a faithful reflow.

import { extractText, getDocumentProxy } from "unpdf";

/**
 * Extracts page 1's text, or `null` when there is no text layer (a scanned
 * PDF) or the page cannot be parsed at all.
 *
 * `null` rather than a throw for BOTH cases: decisions §12.2 says a missing
 * text layer must SKIP tier 1, not fail it, and a corrupt/unparseable PDF is
 * not this function's business to escalate — tier 1 simply has nothing to
 * match against, and detection falls through to tier 2 (model classification)
 * or tier 3 (the dropdown) exactly the same way.
 */
export async function extractPageOneText(buffer: Buffer | Uint8Array): Promise<string | null> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buffer));
  } catch {
    // Not a parseable PDF (corrupt upload, non-PDF bytes that slipped past
    // the content-type check). Same outcome as "no text layer" from here on.
    return null;
  }

  if (pdf.numPages < 1) {
    return null;
  }

  let text: string;
  try {
    const result = await extractText(pdf, { mergePages: false });
    const pages = result.text;
    const page1 = Array.isArray(pages) ? pages[0] : pages;
    text = page1 ?? "";
  } catch {
    return null;
  }

  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The WHOLE document's text, page-numbered, or `null` when there is no text
 * layer at all — the `input_mode: 'text'` half of §3.1.
 *
 * §3.1 is explicit that `input_mode` is a COST decision, not a capability
 * one: "text mode" means the model is handed the extracted text layer
 * INSTEAD of the PDF, at roughly a fifth to a twentieth of the price. So the
 * extraction hop needs every page, not just page 1, and it needs the page
 * boundaries visible — §6.1 keeps a self-reported `page` field on the
 * extraction schema (citations and structured output cannot be combined), and
 * a model asked to report a page number from an unmarked wall of text can
 * only guess.
 *
 * `mergePages: false` then re-joined with an explicit marker, rather than
 * `mergePages: true`: unpdf's merged form concatenates with newlines and
 * loses exactly the boundary this needs.
 *
 * Same `null`-not-throw contract as `extractPageOneText`, and for the same
 * reason — a scan has no text layer, and that is a FACT about the document
 * for the caller to act on (here: refusing to run a text-mode extraction
 * against a document that has no text), not an exception.
 */
export async function extractDocumentText(buffer: Buffer | Uint8Array): Promise<string | null> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    pdf = await getDocumentProxy(new Uint8Array(buffer));
  } catch {
    return null;
  }

  if (pdf.numPages < 1) {
    return null;
  }

  let pages: string[];
  try {
    const result = await extractText(pdf, { mergePages: false });
    pages = Array.isArray(result.text) ? result.text : [result.text];
  } catch {
    return null;
  }

  const rendered = pages
    .map((text, index) => `[página ${String(index + 1)}]\n${text.trim()}`)
    .join("\n\n")
    .trim();

  // Every page empty means no text layer — the pages themselves are still
  // there, so `numPages` cannot answer this.
  return pages.some((text) => text.trim().length > 0) ? rendered : null;
}
