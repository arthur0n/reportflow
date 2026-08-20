// api/detection/detect.ts
//
// Tier 1 of document type detection (decisions §3.3): a free, instant,
// human-verified substring match against page-1 text. No model hop, no S3
// round trip — just the tenant's own frozen `detect_hint` lists.
//
// AMBIGUITY NEVER GUESSES. Zero matches or more than one match both return
// `null` — tier 1's whole contract is "confident hit, or fall through to tier
// 2 (model classification) and tier 3 (the always-present, always-correctable
// dropdown)". A silent misdetection is, per §3.3, "the worst failure mode in
// the system, because nothing surfaces it" — so this function would rather
// answer "I don't know" than pick the more-likely of two matching templates.

import { and, eq, isNull } from "drizzle-orm";
import { documentTypes, extractTemplates } from "../../drizzle/schema";
import type { DbLike } from "../collector/job-state";

export interface DetectionCandidate {
  readonly documentTypeId: string;
  readonly detectHint: readonly string[];
}

export interface HintDetectionResult {
  readonly tier: 1;
  readonly documentTypeId: string;
  readonly confidence: "hint";
}

/**
 * Case- and diacritic-insensitive normalization, applied to BOTH the hint
 * strings and the page text before comparing. A provider's letterhead and a
 * human typing the hint during Calibrate rarely agree on capitalization or
 * accents ("Contribuinte" vs "CONTRIBUINTE", "Não" vs "nao"), and detection
 * must not depend on either side getting that by chance.
 *
 * NFD + strip combining marks is the standard accent-fold; it is safe for
 * pt-BR/pt-PT text specifically (the only vocabulary this hint list ever
 * holds) and does not attempt general Unicode case-folding beyond that.
 */
export function normalizeForMatch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase();
}

/** Every hint in `hints` must appear as a substring of `haystack` — a template
 * with an EMPTY hint list never counts as a candidate (see `hasUsableHints`),
 * so this is only ever called with at least one real hint to check. */
function allHintsPresent(hints: readonly string[], normalizedHaystack: string): boolean {
  return hints.every((hint) => normalizedHaystack.includes(normalizeForMatch(hint)));
}

function hasUsableHints(detectHint: unknown): detectHint is string[] {
  return (
    Array.isArray(detectHint) &&
    detectHint.length > 0 &&
    detectHint.every((h) => typeof h === "string" && h.trim().length > 0)
  );
}

/**
 * The tenant's active extract templates that carry at least one usable
 * `detect_hint` string, joined to their (also active) document type.
 *
 * A template with an empty `detect_hint` array is NOT a candidate: an empty
 * hint list would vacuously "match" every page (§3.3's Calibrate flow only
 * confirms a hint the human actually reviewed — an unconfigured one is not a
 * signal, and treating it as one would turn "nobody set a hint yet" into a
 * false-positive tier-1 hit).
 */
export async function loadHintCandidates(
  dbHandle: DbLike,
  tenantId: string,
): Promise<DetectionCandidate[]> {
  const rows = await dbHandle
    .select({
      documentTypeId: documentTypes.id,
      detectHint: extractTemplates.detectHint,
    })
    .from(extractTemplates)
    .innerJoin(
      documentTypes,
      and(eq(documentTypes.id, extractTemplates.documentTypeId), isNull(documentTypes.deletedAt)),
    )
    .where(and(eq(extractTemplates.tenantId, tenantId), isNull(extractTemplates.deletedAt)));

  return rows
    .filter((r): r is typeof r & { detectHint: string[] } => hasUsableHints(r.detectHint))
    .map((r) => ({ documentTypeId: r.documentTypeId, detectHint: r.detectHint }));
}

/**
 * Tier 1: substring match on page-1 text (decisions §3.3, §12.2).
 *
 * `pageText === null` means the API could not get page-1 text at all (no text
 * layer — a scan — or an unparseable PDF, see `extractPageOneText`). Tier 1
 * has nothing to match against either way, so it is skipped identically to a
 * `null` result: no hit, fall through to tier 2.
 *
 * Returns `null` for "no confident hit" — zero candidates matched, or more
 * than one did. Returns the hit only when EXACTLY ONE template's full hint
 * list is present in the text.
 */
export async function detectDocumentType(
  dbHandle: DbLike,
  tenantId: string,
  pageText: string | null,
): Promise<HintDetectionResult | null> {
  if (pageText === null || pageText.trim().length === 0) {
    return null;
  }

  const candidates = await loadHintCandidates(dbHandle, tenantId);
  if (candidates.length === 0) {
    return null;
  }

  const normalizedText = normalizeForMatch(pageText);
  const matches = candidates.filter((c) => allHintsPresent(c.detectHint, normalizedText));

  if (matches.length !== 1) {
    // Zero: no template's hints all showed up. Multiple: the hints are not
    // distinctive enough to tell two types apart on THIS document — both are
    // "no confident answer", never "pick one".
    return null;
  }

  const only = matches[0];
  if (only === undefined) {
    return null;
  }
  return { tier: 1, documentTypeId: only.documentTypeId, confidence: "hint" };
}
