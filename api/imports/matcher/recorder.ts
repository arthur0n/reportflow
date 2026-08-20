// Decision recorder — append-only learning log writer.
//
// Called from statementImportRows.review after the row update commits. Emits
// one import_match_decisions row per classifier the user touched, plus an
// import_match_rules row per autoMatchPatterns entry (origin='user_promoted').
// Best-effort: caller wraps in try/catch so a recorder failure cannot roll
// back the user's review. All writes happen in one transaction so a partial
// batch is impossible.

import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../db/client";
import { tenantValues, importMatchDecisions, importMatchRules } from "../../../drizzle/schema";
import { withSystemFields } from "../../db/scope";
import { normalizeForMatch } from "./normalize";
import { clearMatchRulesCache } from "./strategies/rule";
import type { MatchOutcome, MatchTargetKey } from "./types";

type ClassifierField = "categoryId" | "creditorId" | "paymentMethodId" | "subtypeId";

type DecisionTargetKind = "CATEGORY" | "PAYMENT_METHOD" | "SUPPLIER" | "CUSTOMER" | "SUBTYPE";

type RuleTargetKind = "CATEGORY" | "PAYMENT_METHOD" | "SUPPLIER" | "CUSTOMER" | "SUBTYPE";

export type RecordDecisionArgs = {
  ctx: { tenantId: string; userId: string };
  rowBefore: {
    id: string;
    description: string | null;
    categoryId: string | null;
    creditorId: string | null;
    paymentMethodId: string | null;
    subtypeId: string | null;
    matchProposalJson: Record<MatchTargetKey, MatchOutcome> | null;
  };
  rowAfter: {
    categoryId: string | null;
    creditorId: string | null;
    paymentMethodId: string | null;
    subtypeId: string | null;
  };
  autoMatchPatterns?:
    | Array<{
        targetKind: RuleTargetKind;
        pattern?: string | undefined;
      }>
    | undefined;
};

type DecisionInsert = {
  field: ClassifierField;
  targetKind: DecisionTargetKind;
  newTargetId: string;
  oldTargetId: string | null;
  proposalKey: MatchTargetKey;
};

type RulePromotion = {
  targetKind: RuleTargetKind;
  pattern: string;
  newTargetId: string;
};

const FIELD_TO_DECISION_KIND: Record<Exclude<ClassifierField, "creditorId">, DecisionTargetKind> = {
  categoryId: "CATEGORY",
  paymentMethodId: "PAYMENT_METHOD",
  subtypeId: "SUBTYPE",
};

const FIELD_TO_PROPOSAL_KEY: Record<Exclude<ClassifierField, "creditorId">, MatchTargetKey> = {
  categoryId: "lov:CATEGORY",
  paymentMethodId: "lov:PAYMENT_METHOD",
  subtypeId: "lov:TRANSACTION_SUBTYPE",
};

function isLovTargetKind(kind: DecisionTargetKind): boolean {
  return kind === "CATEGORY" || kind === "PAYMENT_METHOD" || kind === "SUBTYPE";
}

function clamp01To100(value: number | null | undefined): number | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value * 100)));
}

function bestFromOutcome(
  outcome: MatchOutcome | undefined,
): { strategyId: string; targetId: string; confidence: number } | null {
  if (outcome?.status !== "matched") return null;
  return {
    strategyId: outcome.best.strategyId,
    targetId: outcome.best.targetId,
    confidence: outcome.best.confidence,
  };
}

/**
 * Map creditor_id (tenant_values.id) to its kind discriminator. One SELECT;
 * if the row vanished between review and recording, returns null and the
 * caller skips that field's decision row.
 */
async function lookupCreditorKind(
  tenantId: string,
  creditorId: string,
): Promise<"SUPPLIER" | "CUSTOMER" | null> {
  const rows = await db
    .select({ kind: tenantValues.kind })
    .from(tenantValues)
    .where(and(eq(tenantValues.id, creditorId), eq(tenantValues.tenantId, tenantId)))
    .limit(1);
  const hit = rows[0];
  if (hit === undefined) return null;
  if (hit.kind === "SUPPLIER" || hit.kind === "CUSTOMER") return hit.kind;
  return null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function buildDecisionRows(
  rowBefore: RecordDecisionArgs["rowBefore"],
  rowAfter: RecordDecisionArgs["rowAfter"],
  tenantId: string,
): Promise<DecisionInsert[]> {
  const out: DecisionInsert[] = [];

  for (const field of ["categoryId", "paymentMethodId", "subtypeId"] as const) {
    const next = rowAfter[field];
    const prev = rowBefore[field];
    if (next === prev) continue;
    if (next === null) continue; // user-cleared: not recorded for now
    out.push({
      field,
      targetKind: FIELD_TO_DECISION_KIND[field],
      newTargetId: next,
      oldTargetId: prev,
      proposalKey: FIELD_TO_PROPOSAL_KEY[field],
    });
  }

  if (rowAfter.creditorId !== rowBefore.creditorId && rowAfter.creditorId !== null) {
    const kind = await lookupCreditorKind(tenantId, rowAfter.creditorId);
    if (kind !== null) {
      out.push({
        field: "creditorId",
        targetKind: kind,
        newTargetId: rowAfter.creditorId,
        oldTargetId: rowBefore.creditorId,
        proposalKey: `tv:${kind}` as MatchTargetKey,
      });
    }
  }

  return out;
}

function buildPromotions(args: RecordDecisionArgs): RulePromotion[] {
  const { rowBefore, rowAfter, autoMatchPatterns } = args;
  if (autoMatchPatterns === undefined || autoMatchPatterns.length === 0) return [];
  const out: RulePromotion[] = [];
  for (const entry of autoMatchPatterns) {
    const targetId = resolveTargetIdForPromotion(entry.targetKind, rowAfter);
    if (targetId === null) continue;
    const pattern = (entry.pattern ?? rowBefore.description ?? "").trim();
    if (pattern.length < 2) continue;
    out.push({ targetKind: entry.targetKind, pattern, newTargetId: targetId });
  }
  return out;
}

function pickDecisionKind(
  oldTargetId: string | null,
  newTargetId: string,
  proposal: ReturnType<typeof bestFromOutcome>,
): "accepted" | "overridden" | "manual" {
  if (oldTargetId !== null && oldTargetId !== newTargetId) return "overridden";
  if (proposal !== null && proposal.targetId === newTargetId) return "accepted";
  return "manual";
}

async function insertDecisionRow(
  tx: Tx,
  ctx: RecordDecisionArgs["ctx"],
  rowBefore: RecordDecisionArgs["rowBefore"],
  d: DecisionInsert,
  inputRaw: string,
  inputNormalized: string,
): Promise<void> {
  const proposal = bestFromOutcome(rowBefore.matchProposalJson?.[d.proposalKey]);
  const decisionKind = pickDecisionKind(d.oldTargetId, d.newTargetId, proposal);
  const isLov = isLovTargetKind(d.targetKind);
  const overridden = decisionKind === "overridden";

  await tx.insert(importMatchDecisions).values(
    withSystemFields(ctx, "create", {
      tenantId: ctx.tenantId,
      statementImportRowId: rowBefore.id,
      targetKind: d.targetKind,
      lovTargetId: isLov ? d.newTargetId : null,
      tvTargetId: isLov ? null : d.newTargetId,
      inputRaw,
      inputNormalized,
      proposedByStrategy: proposal?.strategyId ?? null,
      proposedConfidence: clamp01To100(proposal?.confidence ?? null),
      decisionKind,
      overriddenLovTargetId: overridden && isLov ? d.oldTargetId : null,
      overriddenTvTargetId: overridden && !isLov ? d.oldTargetId : null,
    }),
  );
}

async function tryInsertPromotion(
  tx: Tx,
  ctx: RecordDecisionArgs["ctx"],
  p: RulePromotion,
): Promise<boolean> {
  const isLov = isLovTargetKind(p.targetKind);
  const lovTargetId = isLov ? p.newTargetId : null;
  const tvTargetId = isLov ? null : p.newTargetId;

  // Idempotency: skip if a non-deleted rule with the same (tenant, kind,
  // match_kind, pattern, target) already exists. Ticking the checkbox
  // repeatedly must be safe.
  const targetCondition = isLov
    ? eq(importMatchRules.lovTargetId, lovTargetId as string)
    : eq(importMatchRules.tvTargetId, tvTargetId as string);
  const existing = await tx
    .select({ id: importMatchRules.id })
    .from(importMatchRules)
    .where(
      and(
        eq(importMatchRules.tenantId, ctx.tenantId),
        eq(importMatchRules.targetKind, p.targetKind),
        eq(importMatchRules.matchKind, "contains"),
        eq(importMatchRules.pattern, p.pattern),
        targetCondition,
        isNull(importMatchRules.deletedAt),
      ),
    )
    .limit(1);

  if (existing.length > 0) return false;

  await tx.insert(importMatchRules).values(
    withSystemFields(ctx, "create", {
      tenantId: ctx.tenantId,
      category: null,
      targetKind: p.targetKind,
      matchKind: "contains",
      pattern: p.pattern,
      lovTargetId,
      tvTargetId,
      confidence: 85,
      priority: 100,
      origin: "user_promoted",
    }),
  );
  return true;
}

export async function recordDecision(args: RecordDecisionArgs): Promise<void> {
  const { ctx, rowBefore, rowAfter } = args;
  const inputRaw = (rowBefore.description ?? "").trim();
  const inputNormalized = normalizeForMatch(rowBefore.description);

  const decisions = await buildDecisionRows(rowBefore, rowAfter, ctx.tenantId);
  const promotions = buildPromotions(args);

  if (decisions.length === 0 && promotions.length === 0) return;

  const promotedAny = await db.transaction(async (tx) => {
    for (const d of decisions) {
      await insertDecisionRow(tx, ctx, rowBefore, d, inputRaw, inputNormalized);
    }
    let promoted = false;
    for (const p of promotions) {
      const inserted = await tryInsertPromotion(tx, ctx, p);
      if (inserted) promoted = true;
    }
    return promoted;
  });

  if (promotedAny) {
    clearMatchRulesCache({ kind: "tenant", tenantId: ctx.tenantId });
  }
}

function resolveTargetIdForPromotion(
  targetKind: RuleTargetKind,
  rowAfter: RecordDecisionArgs["rowAfter"],
): string | null {
  if (targetKind === "CATEGORY") return rowAfter.categoryId;
  if (targetKind === "PAYMENT_METHOD") return rowAfter.paymentMethodId;
  if (targetKind === "SUBTYPE") return rowAfter.subtypeId;
  // SUPPLIER / CUSTOMER both live on creditorId; the caller is responsible for
  // ticking the checkbox under the correct picker, so we trust their kind label.
  return rowAfter.creditorId;
}
