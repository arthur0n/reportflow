// api/trpc/routers/admin-lov.router.ts
//
// Admin-only LOV catalog management. Surfaces tenant-created LOV rows as
// promotion candidates and drives promote-in-place (tenant_id → NULL).
//
// Cross-tenant duplicate folding is NOT a separate admin action — it happens
// automatically inside lovCreate when a second tenant tries to create the
// same code (auto-promote). Admin manual promote is for the single-tenant
// preemptive case ("this row is generally useful, push it to the catalog").
//
// Promotion candidates are implicit: every active tenant-scoped LOV row of a
// given type is a candidate. The "queue" is a sorted query, not a state table.

import { z } from "zod/v4";
import { and, asc, eq, isNotNull, isNull, type SQL } from "drizzle-orm";
import { router, adminProcedure } from "../procedures";
import { listOfValues } from "../../../drizzle/schema";
import { lovPromoteToSystem } from "../../services/lov-crud";

export const adminLovRouter = router({
  /**
   * Debug-only: dump every row in list_of_values, no audience filter.
   * Bypasses lovConditions on purpose — this is what lets us inspect what
   * the DB actually holds when UI dropdowns look wrong.
   */
  listAll: adminProcedure
    .input(
      z.object({
        type: z.string().trim().min(1).max(50).optional(),
        scope: z.enum(["all", "system", "tenant"]).default("all"),
        includeDeleted: z.boolean().default(true),
      }),
    )
    .query(async ({ ctx, input }) => {
      const conditions: SQL[] = [];
      if (input.type !== undefined) conditions.push(eq(listOfValues.type, input.type));
      if (input.scope === "system") conditions.push(isNull(listOfValues.tenantId));
      if (input.scope === "tenant") conditions.push(isNotNull(listOfValues.tenantId));
      if (!input.includeDeleted) conditions.push(isNull(listOfValues.deletedAt));

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      return ctx.db.raw
        .select({
          id: listOfValues.id,
          type: listOfValues.type,
          code: listOfValues.code,
          value: listOfValues.value,
          description: listOfValues.description,
          category: listOfValues.category,
          parentLov: listOfValues.parentLov,
          language: listOfValues.language,
          sortOrder: listOfValues.sortOrder,
          tenantId: listOfValues.tenantId,
          deletedAt: listOfValues.deletedAt,
          createdAt: listOfValues.createdAt,
        })
        .from(listOfValues)
        .where(where)
        .orderBy(asc(listOfValues.type), asc(listOfValues.sortOrder), asc(listOfValues.code));
    }),

  /** Debug-only: distinct LOV types currently present, for the type filter. */
  listAllTypes: adminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.raw
      .selectDistinct({ type: listOfValues.type })
      .from(listOfValues)
      .orderBy(asc(listOfValues.type));
    return rows.map((r) => r.type);
  }),

  /**
   * List active tenant-scoped rows of a given LOV type, ordered by how many
   * distinct tenants have rows with the same code (cross-tenant frequency)
   * and then by age. Cross-tenant frequency is the strongest "this should
   * be system" signal.
   */
  listPromotionCandidates: adminProcedure
    .input(z.object({ type: z.string().trim().min(1).max(50) }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.raw
        .select({
          id: listOfValues.id,
          tenantId: listOfValues.tenantId,
          value: listOfValues.value,
          code: listOfValues.code,
          createdAt: listOfValues.createdAt,
        })
        .from(listOfValues)
        .where(
          and(
            eq(listOfValues.type, input.type),
            isNotNull(listOfValues.tenantId),
            isNull(listOfValues.deletedAt),
          ),
        )
        .orderBy(asc(listOfValues.createdAt));

      const freq = new Map<string, number>();
      for (const r of rows) {
        freq.set(r.code, (freq.get(r.code) ?? 0) + 1);
      }

      return rows
        .map((r) => ({ ...r, crossTenantCount: freq.get(r.code) ?? 1 }))
        .sort((a, b) => {
          if (a.crossTenantCount !== b.crossTenantCount) {
            return b.crossTenantCount - a.crossTenantCount;
          }
          return a.createdAt < b.createdAt ? -1 : 1;
        });
    }),

  /**
   * Promote a tenant LOV row to a system row. Atomic flip of tenant_id to
   * NULL; preserves the row id so existing transactions FKs keep resolving.
   * `category` is the audience scope (e.g. 'restaurant') or null for global.
   */
  promote: adminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        category: z.string().trim().min(1).max(50).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.raw.transaction(async (tx) => {
        return lovPromoteToSystem(tx, {
          actorUserId: ctx.userId,
          rowId: input.id,
          category: input.category,
        });
      });
    }),
});
