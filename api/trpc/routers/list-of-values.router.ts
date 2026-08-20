// api/trpc/routers/list-of-values.router.ts
//
// LOV accessor for UI dropdowns and the create-with-suggestions dialog.
// `list` returns combined system + tenant rows for a given type. `suggest`
// runs the similarity engine
// for the create dialog. `type` is REQUIRED on every query — type-less LOV
// reads are a foot-gun (see CLAUDE.md NEVER list).

import { z } from "zod/v4";
import { router, protectedProcedure } from "../procedures";
import { db } from "../../db/client";
import { findSimilarLovRows } from "../../services/lov-similarity";

export const listOfValuesRouter = router({
  /** List active LOV rows for a given `type`, system + tenant merged. */
  list: protectedProcedure
    .input(z.object({ type: z.string().trim().min(1).max(50) }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.lov.list({ type: input.type, mode: "combined" });
      return rows
        .map((r) => ({
          id: r.id,
          code: r.code,
          value: r.value,
          type: r.type,
          description: r.description,
          parentLov: r.parentLov,
          language: r.language,
          sortOrder: r.sortOrder,
          tenantId: r.tenantId,
        }))
        .sort((a, b) => {
          const so = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
          if (so !== 0) return so;
          return a.code.localeCompare(b.code);
        });
    }),

  /**
   * Find LOV rows similar to a candidate value within the tenant's audience.
   * Returns up to 5 matches sorted by similarity desc; empty when nothing
   * crosses the trigram threshold. Used by the create-with-suggestions dialog
   * before submitting the create mutation.
   */
  suggest: protectedProcedure
    .input(
      z.object({
        type: z.string().trim().min(1).max(50),
        candidateValue: z.string().trim().min(1).max(200),
      }),
    )
    .query(async ({ ctx, input }) => {
      return findSimilarLovRows({
        db,
        type: input.type,
        candidateValue: input.candidateValue,
        scope: { kind: "tenant", tenantId: ctx.tenantId },
      });
    }),
});
