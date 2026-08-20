// api/trpc/routers/transaction-subtypes.router.ts
//
// Per-tenant TRANSACTION_SUBTYPE router — thin domain adapter over the
// LOV-CRUD core. Subtypes are list_of_values rows of type='TRANSACTION_SUBTYPE'.
// Quick-create from the imports review skips the similarity preflight; the
// router always passes confirmedDespiteSuggestions=true so the result is
// always { kind: "created" }.

import { router, protectedProcedure } from "../procedures";
import { db } from "../../db/client";
import { CreateTransactionSubtypeInput } from "../../../shared/validation/transaction-subtype-schemas";
import { lovCreate, type LovCrudConfig } from "../../services/lov-crud";

const CFG: LovCrudConfig = {
  type: "TRANSACTION_SUBTYPE",
  requiresParent: false,
};

export const transactionSubtypesRouter = router({
  create: protectedProcedure
    .input(CreateTransactionSubtypeInput)
    .mutation(async ({ ctx, input }) => {
      return db.transaction(async (tx) => {
        return lovCreate(tx, { tenantId: ctx.tenantId, userId: ctx.userId }, CFG, {
          name: input.name,
          confirmedDespiteSuggestions: true,
        });
      });
    }),
});
