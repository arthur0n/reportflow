// api/services/lov-similarity.ts
//
// Suggestion engine for LOV creates. Two-stage match against list_of_values:
//   1. exact slugified-code hit (similarity = 1.0)
//   2. trigram fuzzy hit using pg_trgm's similarity() function
//
// Feeds the create-with-suggestions UX: if any match is found, the dialog
// shows them and the user picks an existing row OR confirms-and-creates.

import { and, desc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { listOfValues } from "../../drizzle/schema";
import type { DbLike } from "./lov-crud";
import { slugify } from "../../shared/validation/slugify";

// 0.4 surfaces "IFOOD FEE" against "IFOOD" without dragging in noisy
// 2-character-overlap matches like "PIX" vs "TAX". Tuned for short pt-BR
// labels; revisit if false-negatives appear in real usage.
const TRIGRAM_THRESHOLD = 0.4;

// Cap suggestions returned to keep the dialog scannable.
const MAX_SUGGESTIONS = 5;

export type SimilarityScope =
  { kind: "tenant"; tenantId: string; tenantIndustry: string } | { kind: "admin-all" };

export type LovSimilarityMatch = {
  id: string;
  code: string;
  value: string;
  similarity: number;
  source: "system" | "tenant-self" | "tenant-other";
};

/**
 * Find LOV rows similar to a candidate value within the given audience.
 * Returns up to MAX_SUGGESTIONS matches sorted by similarity desc.
 *
 * `scope.kind === "tenant"` filters to rows the tenant can see (combined-mode
 * audience). `admin-all` returns all rows across tenants — admin tooling only.
 *
 * Empty result means "no similar enough match" — caller proceeds with create.
 * pg_trgm extension must be enabled (see migration).
 */
export async function findSimilarLovRows(args: {
  db: DbLike;
  type: string;
  candidateValue: string;
  scope: SimilarityScope;
}): Promise<LovSimilarityMatch[]> {
  const { db, type, candidateValue, scope } = args;
  const slug = slugify(candidateValue);
  if (slug.length === 0) return [];

  const conditions: SQL[] = [eq(listOfValues.type, type), isNull(listOfValues.deletedAt)];

  if (scope.kind === "tenant") {
    const tenantAudience = or(
      eq(listOfValues.tenantId, scope.tenantId),
      and(
        isNull(listOfValues.tenantId),
        or(isNull(listOfValues.category), eq(listOfValues.category, scope.tenantIndustry)),
      ),
    );
    if (tenantAudience !== undefined) conditions.push(tenantAudience);
  }

  const matchPredicate = or(
    eq(listOfValues.code, slug),
    sql`similarity(${listOfValues.value}, ${candidateValue}) >= ${TRIGRAM_THRESHOLD}`,
  );
  if (matchPredicate !== undefined) conditions.push(matchPredicate);

  const simExpr = sql<number>`CASE WHEN ${listOfValues.code} = ${slug} THEN 1.0 ELSE similarity(${listOfValues.value}, ${candidateValue}) END`;

  const rows = await db
    .select({
      id: listOfValues.id,
      code: listOfValues.code,
      value: listOfValues.value,
      tenantId: listOfValues.tenantId,
      sim: simExpr,
    })
    .from(listOfValues)
    .where(and(...conditions))
    .orderBy(desc(simExpr))
    .limit(MAX_SUGGESTIONS);

  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    value: r.value,
    similarity: Number(r.sim),
    source:
      r.tenantId === null
        ? ("system" as const)
        : scope.kind === "tenant" && r.tenantId === scope.tenantId
          ? ("tenant-self" as const)
          : ("tenant-other" as const),
  }));
}
