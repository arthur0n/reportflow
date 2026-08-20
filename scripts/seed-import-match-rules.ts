// scripts/seed-import-match-rules.ts
//
// System seed for import_match_rules. Maps common BR bank-statement memos to
// system LOV targets across two axes:
//   - PAYMENT_METHOD (rail: PIX, TED, BOLETO, ...)
//   - TRANSACTION_SUBTYPE (fiscal/operational tag: TARIFA, IOF, ...)
//
// Both axes can fire on the same row; chain dedups by target_id, not by axis.
// Confidence 85 == AUTO_APPLY_THRESHOLD: every system rule auto-fills its
// FK at parse time when the regex matches the row description. Tenants
// can dial confidence down via the admin router to demote a rule to
// suggest-only, or disable it entirely.

import { and, eq, inArray, isNull } from "drizzle-orm";
import { listOfValues, importMatchRules } from "../drizzle/schema";
import type { drizzle } from "drizzle-orm/node-postgres";
import type { PAYMENT_METHOD_SEED } from "./seed";

type SeedTx = Parameters<Parameters<ReturnType<typeof drizzle>["transaction"]>[0]>[0];

type SystemSubtypeCode = "TARIFA" | "IOF" | "RENDIMENTO" | "JUROS" | "ESTORNO";

export type ImportRuleSeedEntry =
  | {
      targetKind: "PAYMENT_METHOD";
      code: (typeof PAYMENT_METHOD_SEED)[number]["code"];
      matchKind: "regex" | "contains" | "equals";
      pattern: string;
      confidence: number;
      priority: number;
      description: string;
    }
  | {
      targetKind: "SUBTYPE";
      code: SystemSubtypeCode;
      matchKind: "regex" | "contains" | "equals";
      pattern: string;
      confidence: number;
      priority: number;
      description: string;
    };

export const IMPORT_MATCH_RULES_SEED: ReadonlyArray<ImportRuleSeedEntry> = [
  // ─── PAYMENT_METHOD axis ──────────────────────────────────────────────
  {
    targetKind: "PAYMENT_METHOD",
    code: "BOLETO",
    matchKind: "regex",
    pattern: String.raw`PAGAMENTO\s+DE\s+BOLETO|PAG\s+BOLETO|PGTO\s+BOLETO|\bBOLETO\b`,
    confidence: 85,
    priority: 100,
    description: "BR boleto payment memos → PAYMENT_METHOD Boleto",
  },
  {
    targetKind: "PAYMENT_METHOD",
    code: "DEBITO_CONTA",
    matchKind: "regex",
    pattern: String.raw`\bD[ÉE]BITO\s+AUTOM[ÁA]TICO\b|\bDEB\s+AUTOMATICO\b`,
    confidence: 85,
    priority: 100,
    description: "Direct debit memos → PAYMENT_METHOD Débito em conta",
  },
  {
    targetKind: "PAYMENT_METHOD",
    code: "CARTAO_CREDITO",
    matchKind: "regex",
    pattern: String.raw`\bCOMPRA\s+CART[ÃA]O\b|\bCOMPRA\s+VISA\b|\bCOMPRA\s+MASTER\b|\bCART[ÃA]O\s+DE\s+CR[ÉE]DITO\b`,
    confidence: 85,
    priority: 100,
    description: "Card-purchase memos → PAYMENT_METHOD Cartão de crédito",
  },
  // PIX / TED / DOC are split because they have different fees and accounting
  // treatment in Brazil; TRANSFERENCIA is the generic fallback for memos that
  // just say "transferência" without naming a rail. All four can fire on the
  // same row and surface as competing suggestions.
  {
    targetKind: "PAYMENT_METHOD",
    code: "PIX",
    matchKind: "regex",
    pattern: String.raw`\bPIX\b`,
    confidence: 85,
    priority: 100,
    description: "PIX memos → PAYMENT_METHOD PIX",
  },
  {
    targetKind: "PAYMENT_METHOD",
    code: "TED",
    matchKind: "regex",
    pattern: String.raw`\bTED\b`,
    confidence: 85,
    priority: 100,
    description: "TED memos → PAYMENT_METHOD TED",
  },
  {
    targetKind: "PAYMENT_METHOD",
    code: "DOC",
    matchKind: "regex",
    pattern: String.raw`\bDOC\b`,
    confidence: 85,
    priority: 100,
    description: "DOC memos → PAYMENT_METHOD DOC",
  },
  {
    targetKind: "PAYMENT_METHOD",
    code: "TRANSFERENCIA",
    matchKind: "regex",
    pattern: String.raw`\bTRANSFER[ÊE]NCIA\b`,
    confidence: 85,
    priority: 100,
    description: "Generic transferência memos → PAYMENT_METHOD Transferência",
  },
  {
    targetKind: "PAYMENT_METHOD",
    code: "CHEQUE",
    matchKind: "regex",
    pattern: String.raw`\bCHEQUE\b`,
    confidence: 85,
    priority: 100,
    description: "Cheque memos → PAYMENT_METHOD Cheque",
  },
  // ─── SUBTYPE axis ─────────────────────────────────────────────────────
  // Fiscal/operational tags. Orthogonal to PAYMENT_METHOD: a row "DEBITO IOF"
  // gets PAYMENT_METHOD=DEBITO_CONTA AND SUBTYPE=IOF. Future categories like
  // SUBSCRIPTION / DIVIDEND land here too once their patterns are stable.
  {
    targetKind: "SUBTYPE",
    code: "TARIFA",
    matchKind: "regex",
    pattern: String.raw`\bTARIFA\b|\bTAR\s`,
    confidence: 85,
    priority: 100,
    description: "Bank fee memos → SUBTYPE Tarifa",
  },
  {
    targetKind: "SUBTYPE",
    code: "IOF",
    matchKind: "regex",
    pattern: String.raw`\bIOF\b`,
    confidence: 85,
    priority: 100,
    description: "IOF tax memos → SUBTYPE IOF",
  },
  {
    targetKind: "SUBTYPE",
    code: "RENDIMENTO",
    matchKind: "regex",
    pattern: String.raw`\bRENDIMENTO\b|\bRENDIMENTOS\b`,
    confidence: 85,
    priority: 100,
    description: "Yield/interest credit memos → SUBTYPE Rendimento",
  },
  {
    targetKind: "SUBTYPE",
    code: "JUROS",
    matchKind: "regex",
    pattern: String.raw`\bJUROS\b`,
    confidence: 85,
    priority: 100,
    description: "Interest charge memos → SUBTYPE Juros",
  },
  {
    targetKind: "SUBTYPE",
    code: "ESTORNO",
    matchKind: "regex",
    pattern: String.raw`\bESTORNO\b`,
    confidence: 85,
    priority: 100,
    description: "Reversal memos → SUBTYPE Estorno",
  },
];

function lovTypeOf(targetKind: ImportRuleSeedEntry["targetKind"]): string {
  return targetKind === "PAYMENT_METHOD" ? "PAYMENT_METHOD" : "TRANSACTION_SUBTYPE";
}

/**
 * Idempotent seed for system-scoped import_match_rules. Owns rows where
 * (tenant_id IS NULL, origin='system_seed') and dedups by the natural
 * composite (target_kind, match_kind, pattern, lov_target_id). Rows with
 * origin='admin' or 'user_promoted', and any tenant-scoped rows, are never
 * touched. Orphans (rows whose composite is no longer in the seed list) are
 * hard-deleted so the seed acts as the source of truth.
 */
export async function seedSystemImportMatchRules(tx: SeedTx): Promise<void> {
  const lovRows = await tx
    .select({ id: listOfValues.id, type: listOfValues.type, code: listOfValues.code })
    .from(listOfValues)
    .where(
      and(
        inArray(listOfValues.type, ["PAYMENT_METHOD", "TRANSACTION_SUBTYPE"]),
        isNull(listOfValues.tenantId),
        isNull(listOfValues.deletedAt),
      ),
    );
  const lovIdByTypeAndCode = new Map(lovRows.map((r) => [`${r.type}|${r.code}`, r.id]));

  const resolved = IMPORT_MATCH_RULES_SEED.map((seed) => {
    const lovTargetId = lovIdByTypeAndCode.get(`${lovTypeOf(seed.targetKind)}|${seed.code}`);
    if (lovTargetId === undefined) {
      throw new Error(
        `[seed] IMPORT_MATCH_RULES references unknown ${lovTypeOf(seed.targetKind)} code '${seed.code}'`,
      );
    }
    return { seed, lovTargetId };
  });

  const ownedKeys = new Set(
    resolved.map(
      (r) => `${r.seed.targetKind}|${r.seed.matchKind}|${r.seed.pattern}|${r.lovTargetId}`,
    ),
  );

  const existingSystemSeed = await tx
    .select({
      id: importMatchRules.id,
      targetKind: importMatchRules.targetKind,
      matchKind: importMatchRules.matchKind,
      pattern: importMatchRules.pattern,
      lovTargetId: importMatchRules.lovTargetId,
    })
    .from(importMatchRules)
    .where(and(isNull(importMatchRules.tenantId), eq(importMatchRules.origin, "system_seed")));

  const orphanIds = existingSystemSeed
    .filter((r) => r.lovTargetId !== null)
    .filter(
      (r) => !ownedKeys.has(`${r.targetKind}|${r.matchKind}|${r.pattern}|${r.lovTargetId ?? ""}`),
    )
    .map((r) => r.id);
  if (orphanIds.length > 0) {
    await tx.delete(importMatchRules).where(inArray(importMatchRules.id, orphanIds));
  }

  for (const { seed, lovTargetId } of resolved) {
    const [existing] = await tx
      .select({ id: importMatchRules.id })
      .from(importMatchRules)
      .where(
        and(
          isNull(importMatchRules.tenantId),
          eq(importMatchRules.targetKind, seed.targetKind),
          eq(importMatchRules.matchKind, seed.matchKind),
          eq(importMatchRules.pattern, seed.pattern),
          eq(importMatchRules.lovTargetId, lovTargetId),
        ),
      )
      .limit(1);

    if (existing) {
      await tx
        .update(importMatchRules)
        .set({
          confidence: seed.confidence,
          priority: seed.priority,
          description: seed.description,
          deletedAt: null,
          deletedBy: null,
        })
        .where(eq(importMatchRules.id, existing.id));
      continue;
    }

    await tx.insert(importMatchRules).values({
      tenantId: null,
      category: null,
      targetKind: seed.targetKind,
      matchKind: seed.matchKind,
      pattern: seed.pattern,
      lovTargetId,
      tvTargetId: null,
      confidence: seed.confidence,
      priority: seed.priority,
      origin: "system_seed",
      description: seed.description,
    });
  }

  console.warn(
    `[seed] ✓ IMPORT_MATCH_RULES (${IMPORT_MATCH_RULES_SEED.length} rows, ${orphanIds.length} orphans removed)`,
  );
}
