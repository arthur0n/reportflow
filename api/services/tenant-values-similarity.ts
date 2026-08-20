// api/services/tenant-values-similarity.ts
//
// Suggestion engine for tenant_values creates and import-row resolution.
// Two-stage match against tenant_values scoped to (tenant_id, kind):
//   1. exact slugified-code hit (similarity = 1.0)
//   2. trigram fuzzy hit using pg_trgm's similarity() function
//
// Mirrors api/services/lov-similarity.ts; the only differences are the table
// (tenant_values), the discriminator column (`kind` vs `type`), and the
// audience (always single-tenant — tenant_values has no system rows).

import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { tenantValues } from "../../drizzle/schema";
import type { DbLike } from "./tenant-values-crud";
import { slugify } from "../../shared/validation/slugify";

// Same threshold as findSimilarLovRows; tuned for short pt-BR labels.
const TRIGRAM_THRESHOLD = 0.4;

const MAX_SUGGESTIONS = 5;

export type TenantValuesSimilarityMatch = {
  id: string;
  code: string;
  value: string;
  similarity: number;
};

/**
 * Find tenant_values rows similar to a candidate value within (tenantId, kind).
 * Returns up to MAX_SUGGESTIONS matches sorted by similarity desc.
 *
 * Empty input or empty slug returns []. Soft-deleted rows are excluded.
 * pg_trgm extension must be enabled (see migrations).
 */
export async function findSimilarTenantValues(args: {
  db: DbLike;
  tenantId: string;
  kind: string;
  candidateValue: string;
}): Promise<TenantValuesSimilarityMatch[]> {
  const { db, tenantId, kind, candidateValue } = args;
  const slug = slugify(candidateValue);
  if (slug.length === 0) return [];

  const matchPredicate = or(
    eq(tenantValues.code, slug),
    sql`similarity(${tenantValues.value}, ${candidateValue}) >= ${TRIGRAM_THRESHOLD}`,
  );

  const simExpr = sql<number>`CASE WHEN ${tenantValues.code} = ${slug} THEN 1.0 ELSE similarity(${tenantValues.value}, ${candidateValue}) END`;

  const rows = await db
    .select({
      id: tenantValues.id,
      code: tenantValues.code,
      value: tenantValues.value,
      sim: simExpr,
    })
    .from(tenantValues)
    .where(
      and(
        eq(tenantValues.tenantId, tenantId),
        eq(tenantValues.kind, kind),
        isNull(tenantValues.deletedAt),
        matchPredicate,
      ),
    )
    .orderBy(desc(simExpr))
    .limit(MAX_SUGGESTIONS);

  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    value: r.value,
    similarity: Number(r.sim),
  }));
}
