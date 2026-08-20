// Typed loaders for import_match_rules.
//
// Read-side helpers consumed by RuleMatcher (system + tenant pools, ordered by
// priority). The dual-scope shape mirrors list_of_values: rows with tenant_id
// IS NULL apply to every tenant; rows with tenant_id = X are scoped. System
// rules also carry an optional `category` audience filter.

import { and, asc, eq, isNull, or } from "drizzle-orm";
import { db } from "../../db/client";
import { importMatchRules } from "../../../drizzle/schema";

export type RuleRow = {
  id: string;
  tenantId: string | null;
  category: string | null;
  targetKind: string;
  matchKind: "regex" | "contains" | "equals";
  pattern: string;
  lovTargetId: string | null;
  tvTargetId: string | null;
  confidence: number;
  priority: number;
  origin: "system_seed" | "admin" | "user_promoted";
};

function toRuleRow(r: {
  id: string;
  tenantId: string | null;
  category: string | null;
  targetKind: string;
  matchKind: string;
  pattern: string;
  lovTargetId: string | null;
  tvTargetId: string | null;
  confidence: number | null;
  priority: number | null;
  origin: string;
}): RuleRow {
  return {
    id: r.id,
    tenantId: r.tenantId,
    category: r.category,
    targetKind: r.targetKind,
    matchKind: r.matchKind as RuleRow["matchKind"],
    pattern: r.pattern,
    lovTargetId: r.lovTargetId,
    tvTargetId: r.tvTargetId,
    confidence: Number(r.confidence ?? 0),
    priority: Number(r.priority ?? 0),
    origin: r.origin as RuleRow["origin"],
  };
}

/**
 * Load enabled (non-deleted) system rules for a target_kind, narrowed to the
 * tenant's audience. Returns rows where category IS NULL OR category = industry.
 * If tenantIndustry is null, only universal (category IS NULL) rows match.
 */
export async function loadSystemRules(args: {
  targetKind: string;
  tenantIndustry: string | null;
}): Promise<RuleRow[]> {
  const audience =
    args.tenantIndustry === null || args.tenantIndustry.length === 0
      ? isNull(importMatchRules.category)
      : or(isNull(importMatchRules.category), eq(importMatchRules.category, args.tenantIndustry));

  const rows = await db
    .select({
      id: importMatchRules.id,
      tenantId: importMatchRules.tenantId,
      category: importMatchRules.category,
      targetKind: importMatchRules.targetKind,
      matchKind: importMatchRules.matchKind,
      pattern: importMatchRules.pattern,
      lovTargetId: importMatchRules.lovTargetId,
      tvTargetId: importMatchRules.tvTargetId,
      confidence: importMatchRules.confidence,
      priority: importMatchRules.priority,
      origin: importMatchRules.origin,
    })
    .from(importMatchRules)
    .where(
      and(
        isNull(importMatchRules.tenantId),
        isNull(importMatchRules.deletedAt),
        eq(importMatchRules.targetKind, args.targetKind),
        audience,
      ),
    )
    .orderBy(asc(importMatchRules.priority));

  return rows.map(toRuleRow);
}

/** Load enabled (non-deleted) tenant rules for (tenantId, targetKind). */
export async function loadTenantRules(args: {
  tenantId: string;
  targetKind: string;
}): Promise<RuleRow[]> {
  const rows = await db
    .select({
      id: importMatchRules.id,
      tenantId: importMatchRules.tenantId,
      category: importMatchRules.category,
      targetKind: importMatchRules.targetKind,
      matchKind: importMatchRules.matchKind,
      pattern: importMatchRules.pattern,
      lovTargetId: importMatchRules.lovTargetId,
      tvTargetId: importMatchRules.tvTargetId,
      confidence: importMatchRules.confidence,
      priority: importMatchRules.priority,
      origin: importMatchRules.origin,
    })
    .from(importMatchRules)
    .where(
      and(
        eq(importMatchRules.tenantId, args.tenantId),
        isNull(importMatchRules.deletedAt),
        eq(importMatchRules.targetKind, args.targetKind),
      ),
    )
    .orderBy(asc(importMatchRules.priority));

  return rows.map(toRuleRow);
}
