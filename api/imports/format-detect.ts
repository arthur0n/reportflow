// api/imports/format-detect.ts
//
// Magic-byte-based format detection. Never trusts the file extension.

import type { Parser } from "./parsers/types";
import { ofxParser } from "./parsers/ofx";
import { cieloSalesParser } from "./parsers/cielo-sales";

// Registered parsers — add new formats here as they ship. Order matters:
// first matching detect() wins, so the most specific signatures go first.
const PARSERS: Parser[] = [ofxParser, cieloSalesParser];

/**
 * Detect the file format by trying each registered parser's detect().
 * Returns the first matching parser, or null if unsupported.
 */
export function detectFormat(buffer: Buffer): Parser | null {
  for (const parser of PARSERS) {
    if (parser.detect(buffer)) return parser;
  }
  return null;
}
