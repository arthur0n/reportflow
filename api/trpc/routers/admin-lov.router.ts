// api/trpc/routers/admin-lov.router.ts
//
// Platform-admin-only LOV catalog inspection. Read-only visibility into
// SYSTEM rows (tenant_id IS NULL) of list_of_values — a platform admin never
// reads or writes another tenant's rows (decisions §2), so there is no "all"
// or "tenant" scope here, only system.
//
// Tenant admins manage their own tenant-scoped LOV rows through the
// tenant-scoped routers (e.g. listOfValuesRouter), which are always scoped
// to ctx.tenantId via lovConditions().
//
// There used to be cross-tenant promotion machinery here (listing tenant
// rows as "promotion candidates" and flipping tenant_id -> NULL on demand).
// That was a cross-tenant read/write surface a platform admin must never
// have, so it has been removed entirely, along with the admin UI page that
// drove it.

import { z } from "zod/v4";
import { and, asc, eq, isNull, type SQL } from "drizzle-orm";
import { router, platformAdminProcedure } from "../procedures";
import { listOfValues } from "../../../drizzle/schema";

export const adminLovRouter = router({
  /**
   * Debug-only: dump SYSTEM rows (tenant_id IS NULL) of list_of_values.
   * Bypasses lovConditions on purpose — this is what lets us inspect what
   * the DB actually holds when UI dropdowns look wrong. Never reads tenant
   * rows.
   */
  listAll: platformAdminProcedure
    .input(
      z.object({
        type: z.string().trim().min(1).max(50).optional(),
        includeDeleted: z.boolean().default(true),
      }),
    )
    .query(async ({ ctx, input }) => {
      const conditions: SQL[] = [isNull(listOfValues.tenantId)];
      if (input.type !== undefined) conditions.push(eq(listOfValues.type, input.type));
      if (!input.includeDeleted) conditions.push(isNull(listOfValues.deletedAt));

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
        .where(and(...conditions))
        .orderBy(asc(listOfValues.type), asc(listOfValues.sortOrder), asc(listOfValues.code));
    }),

  /** Debug-only: distinct LOV types present among SYSTEM rows. */
  listAllTypes: platformAdminProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.raw
      .selectDistinct({ type: listOfValues.type })
      .from(listOfValues)
      .where(isNull(listOfValues.tenantId))
      .orderBy(asc(listOfValues.type));
    return rows.map((r) => r.type);
  }),
});
