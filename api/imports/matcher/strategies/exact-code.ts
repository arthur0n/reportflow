// ExactCodeMatcher — confidence 1.0 when slugify(candidate) === row.code.
//
// System LOV reads are memoized per Lambda; tenant LOV and tenant_values
// queries are per-call. This is the strategy that owns the system catalog
// cache (clearExactCodeCache is the single bust point).

import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../../db/client";
import { listOfValues, tenantValues } from "../../../../drizzle/schema";
import { slugify } from "../../../../shared/validation/slugify";
import { normalizeForMatch } from "../normalize";
import type { Matcher, MatchCandidate, MatchInput } from "../types";

type SystemRow = { id: string; code: string; value: string };

const systemCache = new Map<string, SystemRow[]>();

async function loadSystemRows(type: string): Promise<SystemRow[]> {
  const cached = systemCache.get(type);
  if (cached !== undefined) return cached;
  const rows = await db
    .select({ id: listOfValues.id, code: listOfValues.code, value: listOfValues.value })
    .from(listOfValues)
    .where(
      and(
        eq(listOfValues.type, type),
        isNull(listOfValues.tenantId),
        isNull(listOfValues.deletedAt),
      ),
    );
  systemCache.set(type, rows);
  return rows;
}

/** Bust the system LOV cache. Call from any procedure that mutates system LOV rows. */
export function clearExactCodeCache(): void {
  systemCache.clear();
}

async function matchLovSystem(type: string, slug: string): Promise<MatchCandidate[]> {
  const rows = await loadSystemRows(type);
  const hit = rows.find((r) => r.code === slug);
  if (hit === undefined) return [];
  return [
    {
      targetId: hit.id,
      targetCode: hit.code,
      targetValue: hit.value,
      confidence: 1.0,
      strategyId: "exact-code",
      reason: `exact code: ${slug}`,
    },
  ];
}

async function matchLovTenant(
  tenantId: string,
  type: string,
  slug: string,
): Promise<MatchCandidate[]> {
  const rows = await db
    .select({ id: listOfValues.id, code: listOfValues.code, value: listOfValues.value })
    .from(listOfValues)
    .where(
      and(
        eq(listOfValues.tenantId, tenantId),
        eq(listOfValues.type, type),
        eq(listOfValues.code, slug),
        isNull(listOfValues.deletedAt),
      ),
    )
    .limit(1);
  const hit = rows[0];
  if (hit === undefined) return [];
  return [
    {
      targetId: hit.id,
      targetCode: hit.code,
      targetValue: hit.value,
      confidence: 1.0,
      strategyId: "exact-code",
      reason: `exact code: ${slug}`,
    },
  ];
}

async function matchTenantValue(
  tenantId: string,
  kind: string,
  slug: string,
): Promise<MatchCandidate[]> {
  const rows = await db
    .select({ id: tenantValues.id, code: tenantValues.code, value: tenantValues.value })
    .from(tenantValues)
    .where(
      and(
        eq(tenantValues.tenantId, tenantId),
        eq(tenantValues.kind, kind),
        eq(tenantValues.code, slug),
        isNull(tenantValues.deletedAt),
      ),
    )
    .limit(1);
  const hit = rows[0];
  if (hit === undefined) return [];
  return [
    {
      targetId: hit.id,
      targetCode: hit.code,
      targetValue: hit.value,
      confidence: 1.0,
      strategyId: "exact-code",
      reason: `exact code: ${slug}`,
    },
  ];
}

export function createExactCodeMatcher(opts: { priority: number }): Matcher {
  return {
    id: "exact-code",
    priority: opts.priority,
    async match(input: MatchInput): Promise<MatchCandidate[]> {
      const cleaned = normalizeForMatch(input.candidate);
      if (cleaned.length === 0) return [];
      const slug = slugify(cleaned);
      if (slug.length === 0) return [];

      const { target, ctx } = input;
      if (target.kind === "lov-system") return matchLovSystem(target.type, slug);
      if (target.kind === "lov-tenant") return matchLovTenant(ctx.tenantId, target.type, slug);
      return matchTenantValue(ctx.tenantId, target.tvKind, slug);
    },
  };
}
