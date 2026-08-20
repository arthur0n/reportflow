// api/trpc/routers/recurrences.router.ts
//
// Single mutation `createWithSource` — opens one DB transaction, inserts the
// source transaction (CERTO/REVISAR/ESTIMADO depending on payload), and when
// a `recurrence` config is present, also inserts the transaction_recurrences
// row + every forecast sibling sharing the same recurrence_id. Optionally
// flips a statement_import_rows row to reviewed_matched against the new
// source transaction so the imports flow remains the single decision point.
//
// Cadence is delegated to a system RECURRENCE_PATTERN LOV row whose
// `description` column carries the iCalendar RRULE string. The mutation
// validates the picked pattern is system-scoped + active + has a non-empty
// description before reading it. No tenant-scoped pattern rows, ever.
//
// All siblings are written as ESTIMADO with actualDate=NULL/actualAmount=NULL
// — the contract `statement-import-rows.router.ts:candidates` matches against
// when a future bank statement reconciles against them. No matcher changes.

import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { router, protectedProcedure } from "../procedures";
import {
  listOfValues,
  statementImportRows,
  transactions,
  transactionRecurrences,
} from "../../../drizzle/schema";
import { CreateWithRecurrenceInput } from "../../../shared/validation/recurrence-schemas";
import { writeAuditEntry } from "../../services/audit";
import {
  insertTransactionInTx,
  loadLovIdMaps,
  requireStatusId,
  type LovIdMaps,
} from "../../services/transactions-create";
import { occurrenceDates } from "../../services/recurrence-generate";

const RECURRENCE_ENTITY = "TRANSACTION_RECURRENCE";
const RECURRENCE_PATTERN_LOV_TYPE = "RECURRENCE_PATTERN";

const REVIEWABLE_STATUSES = [
  "parsed_ok",
  "edited",
  "reviewed_new",
  "reviewed_matched",
  "reviewed_skip",
];

export const recurrencesRouter = router({
  createWithSource: protectedProcedure
    .input(CreateWithRecurrenceInput)
    .mutation(async ({ ctx, input }) => {
      return ctx.db.transaction(async (txDb, tx) => {
        const maps = await loadLovIdMaps(tx);

        const source = await insertTransactionInTx({ txDb, tx, ctx, maps, input: input.source });

        let recurrence: typeof transactionRecurrences.$inferSelect | null = null;
        let generatedCount = 0;

        if (input.recurrence !== undefined) {
          const pattern = await fetchPattern(tx, input.recurrence.recurrencePatternId);

          const occurrences = occurrenceDates({
            start: source.accrualDate,
            rrule: pattern.rrule,
            mode: input.recurrence.mode,
            ...(input.recurrence.mode === "finite"
              ? { repeatCount: input.recurrence.repeatCount }
              : {}),
          });
          const generatedUntil = occurrences[occurrences.length - 1] ?? source.accrualDate;

          recurrence = await txDb.create(transactionRecurrences, {
            mode: input.recurrence.mode,
            repeatCount: input.recurrence.mode === "finite" ? input.recurrence.repeatCount : null,
            recurrencePatternId: input.recurrence.recurrencePatternId,
            startDate: source.accrualDate,
            generatedUntil,
          });

          await txDb.update(transactions, source.id, { recurrenceId: recurrence.id });

          await writeAuditEntry({
            ctx: { tenantId: ctx.tenantId, userId: ctx.userId },
            entityType: RECURRENCE_ENTITY,
            entityId: recurrence.id,
            action: "create",
            after: {
              mode: recurrence.mode,
              repeatCount: recurrence.repeatCount,
              recurrencePatternId: recurrence.recurrencePatternId,
              patternCode: pattern.code,
              startDate: recurrence.startDate,
              generatedUntil: recurrence.generatedUntil,
              sourceTransactionId: source.id,
            },
            tx,
          });

          generatedCount = await insertSiblings({
            txDb,
            tx,
            ctx,
            maps,
            sourceInput: input.source,
            recurrenceId: recurrence.id,
            occurrences,
          });
        }

        if (input.importRowId !== undefined) {
          await bindImportRow({
            tx,
            userId: ctx.userId,
            importRowId: input.importRowId,
            matchedTransactionId: source.id,
          });
        }

        return { source, recurrence, generatedCount };
      });
    }),
});

/**
 * Look up the picked RECURRENCE_PATTERN LOV row, asserting it's a system row
 * (no tenant overrides, ever), active, of the right type, and carries a
 * non-empty `description` (the rrule). Throws TRPC errors otherwise.
 */
async function fetchPattern(
  tx: Parameters<typeof insertTransactionInTx>[0]["tx"],
  patternId: string,
): Promise<{ id: string; code: string; rrule: string }> {
  const [row] = await tx
    .select({
      id: listOfValues.id,
      code: listOfValues.code,
      type: listOfValues.type,
      tenantId: listOfValues.tenantId,
      deletedAt: listOfValues.deletedAt,
      description: listOfValues.description,
    })
    .from(listOfValues)
    .where(eq(listOfValues.id, patternId))
    .limit(1);

  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "recurrence pattern not found" });
  }
  if (row.type !== RECURRENCE_PATTERN_LOV_TYPE) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `LOV row is not a ${RECURRENCE_PATTERN_LOV_TYPE}`,
    });
  }
  if (row.tenantId !== null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "recurrence patterns must be system-scoped",
    });
  }
  if (row.deletedAt !== null) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "recurrence pattern is inactive" });
  }
  if (row.description === null || row.description.trim().length === 0) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `recurrence pattern '${row.code}' has no rrule (description is empty)`,
    });
  }
  return { id: row.id, code: row.code, rrule: row.description };
}

/**
 * Insert one ESTIMADO forecast row per occurrence date, sharing classifiers
 * with the source. Inputs are taken from the original payload (not the
 * inserted source) so we keep the same nullability semantics.
 */
async function insertSiblings(args: {
  txDb: Parameters<typeof insertTransactionInTx>[0]["txDb"];
  tx: Parameters<typeof insertTransactionInTx>[0]["tx"];
  ctx: { tenantId: string; userId: string };
  maps: LovIdMaps;
  sourceInput: Parameters<typeof insertTransactionInTx>[0]["input"];
  recurrenceId: string;
  occurrences: ReadonlyArray<string>;
}): Promise<number> {
  const estimadoId = requireStatusId(args.maps, "ESTIMADO");
  let count = 0;

  for (const date of args.occurrences) {
    await insertTransactionInTx({
      txDb: args.txDb,
      tx: args.tx,
      ctx: args.ctx,
      maps: args.maps,
      recurrenceId: args.recurrenceId,
      input: {
        ...args.sourceInput,
        // Forecast siblings: no realized leg, status pinned to ESTIMADO.
        accrualDate: date,
        dueDate: date,
        actualDate: undefined,
        actualAmount: undefined,
        statusId: estimadoId,
        // Don't propagate externalId — it would collide on the unique index
        // (tenant_id, external_id). The siblings have no source-system id.
        externalId: undefined,
      },
    });
    count++;
  }
  return count;
}

async function bindImportRow(args: {
  tx: Parameters<typeof insertTransactionInTx>[0]["tx"];
  userId: string;
  importRowId: string;
  matchedTransactionId: string;
}): Promise<void> {
  const [row] = await args.tx
    .select({ id: statementImportRows.id, status: statementImportRows.status })
    .from(statementImportRows)
    .where(eq(statementImportRows.id, args.importRowId))
    .limit(1);

  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "import row not found" });
  if (!REVIEWABLE_STATUSES.includes(row.status)) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `import row status '${row.status}' cannot be reviewed`,
    });
  }

  const now = new Date().toISOString();
  await args.tx
    .update(statementImportRows)
    .set({
      status: "reviewed_matched",
      matchedTransactionId: args.matchedTransactionId,
      reviewedAt: now,
      reviewedBy: args.userId,
      lastUpdAt: now,
      lastUpdBy: args.userId,
    })
    .where(eq(statementImportRows.id, args.importRowId));
}
