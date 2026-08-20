// api/trpc/routers/questions.router.ts
//
// DEV TOOLING — temporary Q&A / feedback tracker shared across all signed-in
// users. Globally scoped (no tenantId), so we do NOT call scope.withTenant
// on inserts; we still go through ctx.db.scope() to honor soft-delete.

import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { eq, and, desc, isNotNull, asc } from "drizzle-orm";
import { router, protectedProcedure } from "../procedures";
import { questionsAndFeedback } from "../../../drizzle/schema";
import {
  CreateQuestionInput,
  UpdateQuestionInput,
  AnswerQuestionInput,
  ListQuestionsInput,
} from "../../../shared/validation/question-schemas";

export const questionsRouter = router({
  list: protectedProcedure.input(ListQuestionsInput).query(async ({ ctx, input }) => {
    const filters = [ctx.db.scope(questionsAndFeedback)];
    if (input?.status !== undefined) {
      filters.push(eq(questionsAndFeedback.status, input.status));
    }
    if (input?.kind !== undefined) {
      filters.push(eq(questionsAndFeedback.kind, input.kind));
    }
    if (input?.owner !== undefined) {
      filters.push(eq(questionsAndFeedback.owner, input.owner));
    }
    if (input?.feature !== undefined) {
      filters.push(eq(questionsAndFeedback.feature, input.feature));
    }
    return ctx.db.raw
      .select()
      .from(questionsAndFeedback)
      .where(and(...filters))
      .orderBy(desc(questionsAndFeedback.createdAt));
  }),

  /** Distinct non-null `feature` values currently in use — for UI filter + datalist. */
  features: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.raw
      .selectDistinct({ feature: questionsAndFeedback.feature })
      .from(questionsAndFeedback)
      .where(and(isNotNull(questionsAndFeedback.feature), ctx.db.scope(questionsAndFeedback)))
      .orderBy(asc(questionsAndFeedback.feature));
    return rows.map((r) => r.feature).filter((f): f is string => f !== null);
  }),

  byId: protectedProcedure.input(z.string().uuid()).query(async ({ ctx, input: id }) => {
    const [row] = await ctx.db.raw
      .select()
      .from(questionsAndFeedback)
      .where(and(eq(questionsAndFeedback.id, id), ctx.db.scope(questionsAndFeedback)))
      .limit(1);

    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND" });
    }
    return row;
  }),

  create: protectedProcedure.input(CreateQuestionInput).mutation(async ({ ctx, input }) => {
    const [row] = await ctx.db.raw.insert(questionsAndFeedback).values(input).returning();
    return row;
  }),

  update: protectedProcedure.input(UpdateQuestionInput).mutation(async ({ ctx, input }) => {
    const { id, ...fields } = input;

    const [row] = await ctx.db.raw
      .update(questionsAndFeedback)
      .set({ ...fields, updatedAt: new Date().toISOString() })
      .where(and(eq(questionsAndFeedback.id, id), ctx.db.scope(questionsAndFeedback)))
      .returning();

    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND" });
    }
    return row;
  }),

  answer: protectedProcedure.input(AnswerQuestionInput).mutation(async ({ ctx, input }) => {
    const now = new Date().toISOString();

    const [row] = await ctx.db.raw
      .update(questionsAndFeedback)
      .set({
        answer: input.answer,
        answeredBy: input.answeredBy,
        answeredAt: now,
        status: input.status,
        updatedAt: now,
      })
      .where(and(eq(questionsAndFeedback.id, input.id), ctx.db.scope(questionsAndFeedback)))
      .returning();

    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND" });
    }
    return row;
  }),

  delete: protectedProcedure.input(z.string().uuid()).mutation(async ({ ctx, input: id }) => {
    const [row] = await ctx.db.raw
      .update(questionsAndFeedback)
      .set({ deletedAt: new Date().toISOString() })
      .where(and(eq(questionsAndFeedback.id, id), ctx.db.scope(questionsAndFeedback)))
      .returning({ id: questionsAndFeedback.id });

    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND" });
    }
    return row;
  }),
});
