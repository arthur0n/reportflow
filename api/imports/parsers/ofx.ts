// api/imports/parsers/ofx.ts
//
// OFX parser for Brazilian bank statements. Handles both SGML (v1, most BR
// banks — no closing tags) and XML (v2). Delegates locale-specific normalization
// to the BR locale helper. Emits the raw <BANKID> routing code; the orchestrator
// resolves it to a canonical BANK_SLUG via the BANK_ROUTING LOV.

import type { Parser, ParsedRow, StatementHeader } from "./types";
import { parseAmountBR, parseDateBR, normalizeDescriptionBR } from "../locales/br";

/**
 * Extract the text content of an OFX/SGML tag. Works for both:
 * - SGML: `<TAG>value` (no closing tag)
 * - XML:  `<TAG>value</TAG>`
 */
function extractTag(content: string, tag: string): string | null {
  const pattern = new RegExp(`<${tag}>\\s*([^<\\r\\n]+)`, "i");
  const match = pattern.exec(content);
  return match?.[1]?.trim() ?? null;
}

/**
 * Extract all STMTTRN blocks from the OFX content.
 * Returns raw text blocks between <STMTTRN> and </STMTTRN> (or next <STMTTRN>).
 */
function extractTransactionBlocks(content: string): string[] {
  const blocks: string[] = [];
  const regex = /<STMTTRN>([\s\S]*?)(?=<\/STMTTRN>|<STMTTRN>|<\/BANKTRANLIST>|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    blocks.push(match[1] ?? "");
  }
  return blocks;
}

function pickReference(checknum: string | null, refnum: string | null): string | null {
  for (const candidate of [checknum, refnum]) {
    if (candidate === null) continue;
    const trimmed = candidate.trim();
    if (trimmed.length === 0) continue;
    if (/^0+$/.test(trimmed)) continue;
    return trimmed;
  }
  return null;
}

function parseSingleTransaction(
  block: string,
  lineNumber: number,
  bankRoutingCode: string | null,
): ParsedRow {
  const raw: Record<string, unknown> = {
    DTPOSTED: extractTag(block, "DTPOSTED"),
    TRNAMT: extractTag(block, "TRNAMT"),
    MEMO: extractTag(block, "MEMO"),
    NAME: extractTag(block, "NAME"),
    FITID: extractTag(block, "FITID"),
    TRNTYPE: extractTag(block, "TRNTYPE"),
    CHECKNUM: extractTag(block, "CHECKNUM"),
    REFNUM: extractTag(block, "REFNUM"),
    lineNumber,
  };

  try {
    const dateRaw = extractTag(block, "DTPOSTED");
    const amountRaw = extractTag(block, "TRNAMT");
    const memo = extractTag(block, "MEMO") ?? extractTag(block, "NAME") ?? "";
    const fitid = extractTag(block, "FITID");
    const checknum = extractTag(block, "CHECKNUM");
    const refnum = extractTag(block, "REFNUM");

    if (dateRaw === null) throw new Error("missing DTPOSTED");
    if (amountRaw === null) throw new Error("missing TRNAMT");

    const actualDate = parseDateBR(dateRaw);
    const actualAmount = parseAmountBR(amountRaw);
    const description = normalizeDescriptionBR(memo);

    // Build external_id from FITID if it looks real (not all zeros). The
    // routing code (raw, e.g. "0341") is enough for global uniqueness; the
    // orchestrator separately resolves the human-readable slug.
    let externalId: string | null = null;
    if (fitid !== null && !/^0+$/.test(fitid)) {
      const prefix = bankRoutingCode !== null ? `ofx:${bankRoutingCode}` : "ofx";
      externalId = `${prefix}:${fitid}`;
    }

    // CHECKNUM is the document number on most BR OFX exports; REFNUM is the
    // internal bank reference. Prefer the former, fall back to the latter.
    // Skip all-zero placeholders both formats commonly emit.
    const refCandidate = pickReference(checknum, refnum);
    const reference = refCandidate !== null ? refCandidate.slice(0, 80) : null;

    return {
      kind: "ok",
      raw,
      normalized: {
        actualDate,
        actualAmount,
        description,
        externalId,
        reference,
      },
    };
  } catch (err) {
    return {
      kind: "error",
      raw,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export const ofxParser: Parser = {
  format: "ofx",
  kind: "bank",
  acquirer: null,

  detect(buffer: Buffer): boolean {
    // Read first 1KB as string to check for OFX signatures
    const head = buffer.subarray(0, 1024).toString("utf-8");
    return /OFXHEADER:|<OFX>/i.test(head);
  },

  extractHeader(buffer: Buffer): StatementHeader {
    const content = buffer.toString("utf-8");

    const bankId = extractTag(content, "BANKID");
    const acctId = extractTag(content, "ACCTID");
    const dtStart = extractTag(content, "DTSTART");
    const dtEnd = extractTag(content, "DTEND");
    const curDef = extractTag(content, "CURDEF");

    return {
      bankRoutingCode: bankId,
      accountRef: acctId,
      periodStart: dtStart !== null ? parseDateBR(dtStart) : null,
      periodEnd: dtEnd !== null ? parseDateBR(dtEnd) : null,
      currency: curDef ?? "BRL",
      merchantTaxId: null,
    };
  },

  async *parse(buffer: Buffer): AsyncIterable<ParsedRow> {
    const content = buffer.toString("utf-8");
    const header = this.extractHeader(buffer);
    const blocks = extractTransactionBlocks(content);

    for (const block of blocks) {
      yield parseSingleTransaction(block, blocks.indexOf(block) + 1, header.bankRoutingCode);
    }
  },
};
