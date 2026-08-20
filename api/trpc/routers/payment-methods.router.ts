// api/trpc/routers/payment-methods.router.ts
//
// Per-tenant PAYMENT_METHOD router — thin domain adapter over the LOV-CRUD
// core. Payment methods are list_of_values rows of type='PAYMENT_METHOD'.
// Seeded system rows (tenant_id IS NULL) provide the canonical defaults;
// tenants extend with their own rows via lovCreate (similarity preflight on).

import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { and, sql } from "drizzle-orm";
import { router, protectedProcedure } from "../procedures";
import { db } from "../../db/client";
import { transactions } from "../../../drizzle/schema";
import {
  CreatePaymentMethodInput,
  UpdatePaymentMethodInput,
  PaymentMethodsListInput,
} from "../../../shared/validation/payment-method-schemas";
import {
  lovById,
  lovCreate,
  lovDeactivate,
  lovRestore,
  lovUpdate,
  type LovCrudConfig,
} from "../../services/lov-crud";

const CFG: LovCrudConfig = {
  type: "PAYMENT_METHOD",
  requiresParent: false,
};

export const paymentMethodsRouter = router({
  list: protectedProcedure.input(PaymentMethodsListInput).query(async ({ ctx, input }) => {
    const filters = input ?? {
      status: "active" as const,
      scope: "combined" as const,
    };
    const { status, scope } = filters;

    const mode = scope === "tenant" ? "tenant" : "combined";
    const rows = await ctx.db.lov.list({ type: CFG.type, mode });

    const search = filters.search;
    const needle = search !== undefined && search.length > 0 ? search.toLowerCase() : undefined;

    const filtered = rows.filter((r) => {
      if (status === "active" && r.deletedAt !== null) return false;
      if (status === "inactive") {
        if (r.deletedAt === null) return false;
        if (scope === "combined" && r.tenantId === null) return false;
      }
      if (needle !== undefined && !r.value.toLowerCase().includes(needle)) return false;
      return true;
    });

    filtered.sort((a, b) => {
      const so = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
      if (so !== 0) return so;
      return a.value.localeCompare(b.value);
    });

    return filtered.map((r) => ({
      id: r.id,
      name: r.value,
      sortOrder: r.sortOrder,
      deletedAt: r.deletedAt,
      tenantId: r.tenantId,
      isSystem: r.tenantId === null,
    }));
  }),

  byId: protectedProcedure.input(z.string().uuid()).query(async ({ ctx, input: id }) => {
    const row = await lovById(db, { tenantId: ctx.tenantId, userId: ctx.userId }, CFG, id);
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    return row;
  }),

  create: protectedProcedure.input(CreatePaymentMethodInput).mutation(async ({ ctx, input }) => {
    return db.transaction(async (tx) => {
      return lovCreate(tx, { tenantId: ctx.tenantId, userId: ctx.userId }, CFG, {
        name: input.name,
        tenantIndustry: ctx.tenantIndustry,
        confirmedDespiteSuggestions: input.confirmedDespiteSuggestions ?? false,
      });
    });
  }),

  update: protectedProcedure.input(UpdatePaymentMethodInput).mutation(async ({ ctx, input }) => {
    return db.transaction(async (tx) => {
      return lovUpdate(tx, { tenantId: ctx.tenantId, userId: ctx.userId }, CFG, {
        id: input.id,
        name: input.name,
      });
    });
  }),

  deactivate: protectedProcedure.input(z.string().uuid()).mutation(async ({ ctx, input: id }) => {
    return db.transaction(async (tx) => {
      return lovDeactivate(tx, { tenantId: ctx.tenantId, userId: ctx.userId }, CFG, id);
    });
  }),

  restore: protectedProcedure.input(z.string().uuid()).mutation(async ({ ctx, input: id }) => {
    return db.transaction(async (tx) => {
      return lovRestore(tx, { tenantId: ctx.tenantId, userId: ctx.userId }, CFG, id);
    });
  }),

  transactionsCount: protectedProcedure
    .input(z.object({ ids: z.array(z.string().uuid()).min(1).max(200) }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.raw
        .select({
          paymentMethodId: transactions.paymentMethodId,
          activeCount: sql<number>`count(*) filter (where ${transactions.deletedAt} is null)`.as(
            "active_count",
          ),
          inactiveCount:
            sql<number>`count(*) filter (where ${transactions.deletedAt} is not null)`.as(
              "inactive_count",
            ),
        })
        .from(transactions)
        .where(
          and(
            ctx.db.scope(transactions, { includeDeleted: true }),
            sql`${transactions.paymentMethodId} = ANY(${input.ids})`,
          ),
        )
        .groupBy(transactions.paymentMethodId);

      const byId = new Map<string, { activeCount: number; inactiveCount: number }>();
      for (const row of rows) {
        if (row.paymentMethodId === null) continue;
        byId.set(row.paymentMethodId, {
          activeCount: Number(row.activeCount),
          inactiveCount: Number(row.inactiveCount),
        });
      }
      return input.ids.map((id) => ({
        id,
        activeCount: byId.get(id)?.activeCount ?? 0,
        inactiveCount: byId.get(id)?.inactiveCount ?? 0,
      }));
    }),
});
