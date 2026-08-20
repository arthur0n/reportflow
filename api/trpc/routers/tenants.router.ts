// api/trpc/routers/tenants.router.ts
//
// Active-tenant read + admin update. Billing fields (plan, trial_ends_at,
// billing_email) are intentionally excluded — those are mutated by manual SQL
// during F&F until the billing UI lands.

import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, adminProcedure } from "../procedures";
import { tenants } from "../../../drizzle/schema";
import { writeAuditEntry } from "../../services/audit";

type TenantRow = typeof tenants.$inferSelect;
type TenantPublic = Omit<TenantRow, "deletedAt" | "deletedBy">;

function stripDeleted(row: TenantRow): TenantPublic {
  const { deletedAt: _deletedAt, deletedBy: _deletedBy, ...rest } = row;
  return rest;
}

export const tenantsRouter = router({
  /** The active tenant. ctx.db.byId already enforces the scoped WHERE. */
  current: protectedProcedure.query(async ({ ctx }) => {
    const row = await ctx.db.byId(tenants, ctx.tenantId);
    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: "tenant not found" });
    }
    return stripDeleted(row);
  }),

  /**
   * Update mutable tenant settings. Only fields the caller actually sent are
   * patched; an empty patch is a no-op (no audit, no DB write). Billing
   * fields are not exposed here on purpose.
   */
  update: adminProcedure
    .input(
      z.object({
        name: z.string().min(1).max(200).optional(),
        cnpj: z.string().min(14).max(18).nullable().optional(),
        timezone: z.string().min(1).max(60).optional(),
        fiscalYearStart: z.number().int().min(1).max(12).optional(),
        mode: z.enum(["full", "import_only"]).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const before = await ctx.db.byId(tenants, ctx.tenantId);
      if (!before) {
        throw new TRPCError({ code: "NOT_FOUND", message: "tenant not found" });
      }

      const patch: Record<string, unknown> = {};
      if (input.name !== undefined) patch["name"] = input.name;
      if (input.cnpj !== undefined) patch["cnpj"] = input.cnpj;
      if (input.timezone !== undefined) patch["timezone"] = input.timezone;
      if (input.fiscalYearStart !== undefined) {
        patch["fiscalYearStart"] = input.fiscalYearStart;
      }
      if (input.mode !== undefined) patch["mode"] = input.mode;

      if (Object.keys(patch).length === 0) {
        return stripDeleted(before);
      }

      return ctx.db.transaction(async (txDb, tx) => {
        const updated = await txDb.update(tenants, ctx.tenantId, patch);
        if (!updated) {
          throw new TRPCError({ code: "NOT_FOUND", message: "tenant not found" });
        }

        const beforeDiff: Record<string, unknown> = {};
        const afterDiff: Record<string, unknown> = {};
        for (const key of Object.keys(patch)) {
          beforeDiff[key] = (before as unknown as Record<string, unknown>)[key];
          afterDiff[key] = (updated as unknown as Record<string, unknown>)[key];
        }

        await writeAuditEntry({
          ctx: { tenantId: ctx.tenantId, userId: ctx.userId },
          entityType: "TENANT",
          entityId: ctx.tenantId,
          action: "update",
          before: beforeDiff,
          after: afterDiff,
          tx,
        });

        return stripDeleted(updated);
      });
    }),
});
