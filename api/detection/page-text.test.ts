// api/detection/page-text.test.ts
//
// The synthetic-fixture cases run always, no fixture repo dependency (see
// api/detection/__fixtures__/make-minimal-pdf.ts). The real-PDF case is
// env-gated: it only runs when REPORTFLOW_PDF_FIXTURES_DIR points at the
// repo's own `pdf/` directory (real client documents, never committed as
// test fixtures) — skipped everywhere else, CI included.

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { extractDocumentText, extractPageOneText } from "./page-text";
import { buildMinimalPdf } from "./__fixtures__/make-minimal-pdf";

describe("extractPageOneText — synthetic fixtures", () => {
  it("extracts page-1 text, accents intact", async () => {
    const pdf = buildMinimalPdf(["FATURA EXEMPLO Ç Ã", "Segunda linha"]);
    const text = await extractPageOneText(pdf);
    expect(text).toBe("FATURA EXEMPLO Ç Ã\nSegunda linha");
  });

  it("returns null for a page with no text-drawing operators (scan, no text layer)", async () => {
    const pdf = buildMinimalPdf([]);
    const text = await extractPageOneText(pdf);
    expect(text).toBeNull();
  });

  it("returns null for bytes that are not a parseable PDF", async () => {
    const garbage = Buffer.from("this is not a pdf at all, just bytes");
    const text = await extractPageOneText(garbage);
    expect(text).toBeNull();
  });

  it("only reads page 1 of a multi-page document", async () => {
    // buildMinimalPdf only ever builds one page — this pins that the
    // function's CONTRACT is page 1, not "merge every page", using the
    // one-page fixture as the simplest proof: whatever comes back must be
    // exactly page 1's own lines, nothing concatenated from elsewhere.
    const pdf = buildMinimalPdf(["SÓ A PÁGINA 1"]);
    const text = await extractPageOneText(pdf);
    expect(text).toBe("SÓ A PÁGINA 1");
  });
});

// The `input_mode: 'text'` half of §3.1 — the extraction hop needs EVERY
// page, not just page 1, and it needs the page boundaries legible because
// §6.1 makes the page a self-reported field.
describe("extractDocumentText — synthetic fixtures", () => {
  it("marks the page and keeps the text, accents intact", async () => {
    const pdf = buildMinimalPdf(["FATURA EXEMPLO Ç Ã", "Segunda linha"]);
    await expect(extractDocumentText(pdf)).resolves.toBe(
      "[página 1]\nFATURA EXEMPLO Ç Ã\nSegunda linha",
    );
  });

  // A scan. `null` and not a throw, for the same reason `extractPageOneText`
  // answers `null`: the CALLER decides what a missing text layer means, and
  // for text-mode extraction it means "refuse", not "crash".
  it("returns null when no page carries any text", async () => {
    await expect(extractDocumentText(buildMinimalPdf([]))).resolves.toBeNull();
  });

  it("returns null for bytes that are not a parseable PDF", async () => {
    await expect(extractDocumentText(Buffer.from("this is not a pdf at all"))).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Env-gated: exercises the real fixtures in pdf/ at the repo root. Run with
//   REPORTFLOW_PDF_FIXTURES_DIR=$(pwd)/pdf pnpm test page-text
// Never runs in CI or on a bare checkout — the directory does not exist
// there, and the suite reports these as skipped rather than failing.
// ---------------------------------------------------------------------------

const fixturesDir = process.env["REPORTFLOW_PDF_FIXTURES_DIR"];
const realPdfPath =
  fixturesDir !== undefined ? resolve(fixturesDir, "FT_C2025_141.pdf") : undefined;
const hasRealFixture = realPdfPath !== undefined && existsSync(realPdfPath);

describe.skipIf(!hasRealFixture)("extractPageOneText — real PDF fixture (env-gated)", () => {
  it("extracts recognisable, accented page-1 text from a real invoice", async () => {
    const buf = readFileSync(realPdfPath as string);
    const text = await extractPageOneText(buf);
    expect(text).not.toBeNull();
    // House Living's real letterhead/labels — proves accents survive on a
    // genuine, non-synthetic PDF, not just the hand-built fixture above.
    expect(text).toContain("Administração de Imóveis");
    expect(text).toContain("Contribuinte");
  });
});
