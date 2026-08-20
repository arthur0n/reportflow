// api/trpc/routers/categories.router.ts
//
// Per-tenant CATEGORY router — a thin domain adapter over the LOV-CRUD core
// (api/services/lov-crud.ts). DRE-group resolution and the reclassify audit
// action stay here because they're CATEGORY-specific; everything else is
// reused.

import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { router, protectedProcedure } from "../procedures";
import { db } from "../../db/client";
import { listOfValues, transactions } from "../../../drizzle/schema";
import {
  CreateCategoryInput,
  UpdateCategoryInput,
  ReclassifyCategoryInput,
  CategoriesListInput,
  TransactionsCountInput,
} from "../../../shared/validation/category-schemas";
import {
  lovById,
  lovChangeParent,
  lovCreate,
  lovDeactivate,
  lovListConditions,
  lovRestore,
  lovUpdate,
  type DbLike,
  type LovCrudConfig,
} from "../../services/lov-crud";

const CFG: LovCrudConfig = {
  type: "CATEGORY",
  parentType: "DRE_GROUP",
  requiresParent: true,
};

async function findDreGroupByCode(
  tx: DbLike,
  dreGroupCode: string,
): Promise<{ id: string; code: string }> {
  const [row] = await tx
    .select({ id: listOfValues.id, code: listOfValues.code })
    .from(listOfValues)
    .where(
      and(
        eq(listOfValues.type, "DRE_GROUP"),
        eq(listOfValues.code, dreGroupCode),
        isNull(listOfValues.tenantId),
        isNull(listOfValues.deletedAt),
      ),
    )
    .limit(1);
  if (!row) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Grupo DRE inválido." });
  }
  return row;
}

export const categoriesRouter = router({
  list: protectedProcedure.input(CategoriesListInput).query(async ({ ctx, input }) => {
    const filters = input ?? { status: "active" as const };
    const dre = alias(listOfValues, "dre");

    const conds = lovListConditions(ctx.tenantId, CFG, {
      status: filters.status,
      ...(filters.search !== undefined ? { search: filters.search } : {}),
    });

    if (filters.dreGroupCode !== undefined) {
      const dreGroup = await findDreGroupByCode(ctx.db.raw, filters.dreGroupCode);
      conds.push(eq(listOfValues.parentLov, dreGroup.id));
    }

    return ctx.db.raw
      .select({
        id: listOfValues.id,
        name: listOfValues.value,
        description: listOfValues.description,
        parentLov: listOfValues.parentLov,
        sortOrder: listOfValues.sortOrder,
        deletedAt: listOfValues.deletedAt,
        dreGroup: {
          id: dre.id,
          code: dre.code,
          label: dre.value,
        },
      })
      .from(listOfValues)
      .innerJoin(dre, eq(dre.id, listOfValues.parentLov))
      .where(and(...conds))
      .orderBy(asc(listOfValues.value));
  }),

  byId: protectedProcedure.input(z.string().uuid()).query(async ({ ctx, input: id }) => {
    const row = await lovById(db, { tenantId: ctx.tenantId, userId: ctx.userId }, CFG, id);
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    return row;
  }),

  create: protectedProcedure.input(CreateCategoryInput).mutation(async ({ ctx, input }) => {
    return db.transaction(async (tx) => {
      const dre = await findDreGroupByCode(tx, input.dreGroupCode);
      return lovCreate(tx, { tenantId: ctx.tenantId, userId: ctx.userId }, CFG, {
        name: input.name,
        description: input.description ?? null,
        parentLov: dre.id,
        tenantIndustry: ctx.tenantIndustry,
        confirmedDespiteSuggestions: input.confirmedDespiteSuggestions ?? false,
      });
    });
  }),

  update: protectedProcedure.input(UpdateCategoryInput).mutation(async ({ ctx, input }) => {
    return db.transaction(async (tx) => {
      return lovUpdate(tx, { tenantId: ctx.tenantId, userId: ctx.userId }, CFG, {
        id: input.id,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      });
    });
  }),

  reclassify: protectedProcedure.input(ReclassifyCategoryInput).mutation(async ({ ctx, input }) => {
    return db.transaction(async (tx) => {
      const dre = await findDreGroupByCode(tx, input.dreGroupCode);
      return lovChangeParent(tx, { tenantId: ctx.tenantId, userId: ctx.userId }, CFG, {
        id: input.id,
        parentLov: dre.id,
        auditAction: "reclassify",
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
    .input(TransactionsCountInput)
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.raw
        .select({
          categoryId: transactions.categoryId,
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
            inArray(transactions.categoryId, input.ids),
          ),
        )
        .groupBy(transactions.categoryId);

      const byId = new Map<string, { activeCount: number; inactiveCount: number }>();
      for (const row of rows) {
        if (row.categoryId === null) continue;
        byId.set(row.categoryId, {
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
