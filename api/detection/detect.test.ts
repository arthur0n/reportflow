// api/detection/detect.test.ts
//
// Tier 1 (decisions §3.3, §12.2): substring match, case/diacritic-insensitive,
// never guesses on ambiguity. The DB is mocked — the join shape itself is a
// three-line query and not worth re-proving here; what matters is the
// DECISION `detectDocumentType` reaches for a given set of candidate hints
// and a given page text.

import { describe, it, expect, vi } from "vitest";
import type { DbLike } from "../collector/job-state";
import { detectDocumentType, loadHintCandidates, normalizeForMatch } from "./detect";

const TENANT = "org_2abcTENANT";

function makeJoinDb(rows: unknown[]) {
  const where = vi.fn().mockResolvedValue(rows);
  const innerJoin = vi.fn().mockReturnValue({ where });
  const from = vi.fn().mockReturnValue({ innerJoin });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as unknown as DbLike, select, where, innerJoin };
}

describe("normalizeForMatch", () => {
  it("lowercases and strips accents", () => {
    expect(normalizeForMatch("CONTRIBUINTE: Não")).toBe("contribuinte: nao");
    expect(normalizeForMatch("TOYSMITH COMÉRCIO")).toBe("toysmith comercio");
  });
});

describe("loadHintCandidates", () => {
  it("drops templates with an empty detect_hint list", async () => {
    const { db } = makeJoinDb([
      { documentTypeId: "dt-1", detectHint: [] },
      { documentTypeId: "dt-2", detectHint: ["TOYSMITH"] },
    ]);
    const candidates = await loadHintCandidates(db, TENANT);
    expect(candidates).toEqual([{ documentTypeId: "dt-2", detectHint: ["TOYSMITH"] }]);
  });

  it("drops a hint list containing a blank string", async () => {
    const { db } = makeJoinDb([{ documentTypeId: "dt-1", detectHint: ["TOYSMITH", "  "] }]);
    const candidates = await loadHintCandidates(db, TENANT);
    expect(candidates).toEqual([]);
  });
});

describe("detectDocumentType", () => {
  it("returns null when pageText is null (no text layer / unparseable PDF)", async () => {
    const { db, select } = makeJoinDb([{ documentTypeId: "dt-1", detectHint: ["TOYSMITH"] }]);
    const result = await detectDocumentType(db, TENANT, null);
    expect(result).toBeNull();
    // Skips before even querying candidates — nothing to match against.
    expect(select).not.toHaveBeenCalled();
  });

  it("hits when exactly one template's full hint list is present", async () => {
    const { db } = makeJoinDb([
      { documentTypeId: "dt-toysmith-nf", detectHint: ["TOYSMITH COMÉRCIO", "NOTA FISCAL"] },
      { documentTypeId: "dt-houseliving-fatura", detectHint: ["House Living", "Fatura"] },
    ]);
    const pageText = "TOYSMITH COMÉRCIO LTDA\nNOTA FISCAL Nº 123\nTotal: R$ 100,00";
    const result = await detectDocumentType(db, TENANT, pageText);
    expect(result).toEqual({ tier: 1, documentTypeId: "dt-toysmith-nf", confidence: "hint" });
  });

  it("is diacritic- and case-insensitive on both sides", async () => {
    const { db } = makeJoinDb([{ documentTypeId: "dt-1", detectHint: ["Administração"] }]);
    const pageText = "casa de ADMINISTRACAO de imoveis";
    const result = await detectDocumentType(db, TENANT, pageText);
    expect(result).toEqual({ tier: 1, documentTypeId: "dt-1", confidence: "hint" });
  });

  it("misses (null) when no template's hints all appear", async () => {
    const { db } = makeJoinDb([
      { documentTypeId: "dt-1", detectHint: ["TOYSMITH", "NOTA FISCAL"] },
    ]);
    const pageText = "House Living, Fatura nº 141";
    const result = await detectDocumentType(db, TENANT, pageText);
    expect(result).toBeNull();
  });

  it("returns null (never guesses) when hints from two templates both match", async () => {
    const { db } = makeJoinDb([
      { documentTypeId: "dt-a", detectHint: ["FATURA"] },
      { documentTypeId: "dt-b", detectHint: ["FATURA"] },
    ]);
    const pageText = "Documento: FATURA nº 1";
    const result = await detectDocumentType(db, TENANT, pageText);
    expect(result).toBeNull();
  });

  it("requires EVERY hint in a template's list, not just one", async () => {
    const { db } = makeJoinDb([
      { documentTypeId: "dt-1", detectHint: ["TOYSMITH", "SERVIÇOS ESPECIAIS"] },
    ]);
    // "TOYSMITH" is present; "SERVIÇOS ESPECIAIS" is not a contiguous phrase
    // anywhere in this text (the two words never sit next to each other) —
    // one of two required hints is missing, so this must still miss.
    const pageText = "TOYSMITH COMÉRCIO — presta serviços variados e produtos especiais";
    const result = await detectDocumentType(db, TENANT, pageText);
    expect(result).toBeNull();
  });
});
