// api/services/transactions-create.ts
//
// Tx-scoped insert helper shared by the transactions create mutation and the
// recurrences createWithSource mutation. Owns: TRANSACTION_TYPE/STATUS LOV
// id↔code maps, status defaulting (delegates to transactions-write.ts),
// row insert + audit. Both callers reuse the same maps within a batch.

import { TRPCError } from "@trpc/server";
import { and, inArray, isNull } from "drizzle-orm";
import type { z } from "zod/v4";
import { listOfValues, transactions } from "../../drizzle/schema";
import type { db } from "../db/client";
import type { ScopedDb } from "../db/scoped-client";
import {
  isTransactionTypeCode,
  type TransactionTypeCode,
} from "../../shared/constants/transaction-types";
import {
  assertClassifiersComplete,
  defaultTransactionStatus,
  type DefaultStatusCode,
} from "./transactions-write";
import type { CreateTransactionInput } from "../../shared/validation/transaction-schemas";
import { writeAuditEntry } from "./audit";

export const TRANSACTION_ENTITY = "TRANSACTION";

type DbHandle = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type LovIdMaps = {
  typeCodeById: Map<string, TransactionTypeCode>;
  typeIdByCode: Map<TransactionTypeCode, string>;
  statusIdByCode: Map<DefaultStatusCode, string>;
};

/** Combined fetch for the system LOV id↔code maps the create path needs. */
export async function loadLovIdMaps(dbHandle: DbHandle): Promise<LovIdMaps> {
  const rows = await dbHandle
    .select({ id: listOfValues.id, type: listOfValues.type, code: listOfValues.code })
    .from(listOfValues)
    .where(
      and(
        inArray(listOfValues.type, ["TRANSACTION_TYPE", "TRANSACTION_STATUS"]),
        isNull(listOfValues.tenantId),
        isNull(listOfValues.deletedAt),
      ),
    );

  const typeCodeById = new Map<string, TransactionTypeCode>();
  const typeIdByCode = new Map<TransactionTypeCode, string>();
  const statusIdByCode = new Map<DefaultStatusCode, string>();

  for (const r of rows) {
    if (r.type === "TRANSACTION_TYPE" && isTransactionTypeCode(r.code)) {
      typeCodeById.set(r.id, r.code);
      typeIdByCode.set(r.code, r.id);
    } else if (r.type === "TRANSACTION_STATUS") {
      if (r.code === "CERTO" || r.code === "REVISAR" || r.code === "ESTIMADO") {
        statusIdByCode.set(r.code, r.id);
      }
    }
  }

  return { typeCodeById, typeIdByCode, statusIdByCode };
}

export function requireStatusId(maps: LovIdMaps, code: DefaultStatusCode): string {
  const id = maps.statusIdByCode.get(code);
  if (id === undefined) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: `TRANSACTION_STATUS '${code}' not seeded`,
    });
  }
  return id;
}

export function requireTypeCode(maps: LovIdMaps, id: string): TransactionTypeCode {
  const code = maps.typeCodeById.get(id);
  if (code === undefined) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "transactionTypeId is not a valid TRANSACTION_TYPE row",
    });
  }
  return code;
}

export function resolveStatusId(args: {
  explicitStatusId: string | undefined;
  maps: LovIdMaps;
  typeCode: TransactionTypeCode;
  creditorId: string | null;
  categoryId: string | null;
  paymentMethodId: string | null;
  actualDate: string | null;
  actualAmount: bigint | null;
}): string {
  if (args.explicitStatusId !== undefined) return args.explicitStatusId;
  const missing = assertClassifiersComplete({
    transactionType: args.typeCode,
    creditorId: args.creditorId,
    categoryId: args.categoryId,
    paymentMethodId: args.paymentMethodId,
  });
  const code = defaultTransactionStatus({
    actualDate: args.actualDate,
    actualAmount: args.actualAmount,
    missingClassifiers: missing,
  });
  return requireStatusId(args.maps, code);
}

export function toBigIntOrNull(value: number | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  return BigInt(value);
}

/** JSON-safe projection for audit before / after. */
export function transactionAuditProjection(
  row: typeof transactions.$inferSelect,
): Record<string, unknown> {
  return {
    transactionTypeId: row.transactionTypeId,
    statusId: row.statusId,
    businessUnitId: row.businessUnitId,
    creditorId: row.creditorId,
    categoryId: row.categoryId,
    paymentMethodId: row.paymentMethodId,
    subtypeId: row.subtypeId,
    cashBoxId: row.cashBoxId,
    accrualDate: row.accrualDate,
    dueDate: row.dueDate,
    actualDate: row.actualDate,
    forecastAmount: row.forecastAmount.toString(),
    actualAmount: row.actualAmount?.toString() ?? null,
    description: row.description,
    reference: row.reference,
    externalId: row.externalId,
    recurrenceId: row.recurrenceId,
  };
}

type CreateTransactionInputType = z.infer<typeof CreateTransactionInput>;

/**
 * Insert one transaction inside an existing tx, defaulting status, attaching
 * the optional recurrence_id, and emitting the audit row. Caller owns the
 * outer transaction so siblings + the recurrence row + the import-row update
 * all commit atomically together.
 */
export async function insertTransactionInTx(args: {
  txDb: ScopedDb;
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0];
  ctx: { tenantId: string; userId: string };
  maps: LovIdMaps;
  input: CreateTransactionInputType;
  recurrenceId?: string | null;
}): Promise<typeof transactions.$inferSelect> {
  const { txDb, tx, ctx, maps, input } = args;
  const typeCode = requireTypeCode(maps, input.transactionTypeId);

  const creditorId = input.creditorId ?? null;
  const categoryId = input.categoryId ?? null;
  const paymentMethodId = input.paymentMethodId ?? null;
  const actualDate = input.actualDate ?? null;
  const actualAmount = toBigIntOrNull(input.actualAmount);

  const statusId = resolveStatusId({
    explicitStatusId: input.statusId,
    maps,
    typeCode,
    creditorId,
    categoryId,
    paymentMethodId,
    actualDate,
    actualAmount,
  });

  const created = await txDb.create(transactions, {
    transactionTypeId: input.transactionTypeId,
    statusId,
    businessUnitId: input.businessUnitId ?? null,
    creditorId,
    categoryId,
    paymentMethodId,
    subtypeId: input.subtypeId ?? null,
    cashBoxId: input.cashBoxId ?? null,
    statementImportId: null,
    recurrenceId: args.recurrenceId ?? null,
    accrualDate: input.accrualDate,
    dueDate: input.dueDate,
    actualDate,
    forecastAmount: BigInt(input.forecastAmount),
    actualAmount,
    description: input.description ?? null,
    reference: input.reference ?? null,
    externalId: input.externalId ?? null,
  });

  await writeAuditEntry({
    ctx: { tenantId: ctx.tenantId, userId: ctx.userId },
    entityType: TRANSACTION_ENTITY,
    entityId: created.id,
    action: "create",
    after: transactionAuditProjection(created),
    tx,
  });

  return created;
}
