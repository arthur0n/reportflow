import { z } from "zod/v4";

export const UploadStatementInput = z.object({
  fileName: z.string().trim().min(1).max(255),
  fileContent: z.string().min(1), // base64-encoded
  confirmDuplicate: z.boolean().optional().default(false),
});

export const ResolveCashBoxInput = z.object({
  importId: z.string().uuid(),
  cashBoxId: z.string().uuid(),
});

export const UpdateErrorRowInput = z.object({
  id: z.string().uuid(),
  actualDate: z.string().date().optional(),
  actualAmount: z.number().int().optional(),
  description: z.string().trim().max(1000).optional(),
  // FK → list_of_values.id (type='TRANSACTION_SUBTYPE'). Optional fiscal tag.
  subtypeId: z.string().uuid().nullable().optional(),
});

export const ReviewRowAction = z.enum(["new", "match", "skip"]);

// Per-classifier "match this automatically next time" promotion. When set, the
// review mutation inserts an origin='user_promoted' contains-rule into
// import_match_rules so future imports auto-fill on the same substring.
// `pattern` is optional; if omitted, the recorder falls back to the row's
// trimmed description.
export const AutoMatchPattern = z.object({
  targetKind: z.enum(["CATEGORY", "PAYMENT_METHOD", "SUPPLIER", "CUSTOMER", "SUBTYPE"]),
  pattern: z.string().trim().min(2).max(500).optional(),
});

export const ReviewRowInput = z.object({
  id: z.string().uuid(),
  action: ReviewRowAction,
  matchedTransactionId: z.string().uuid().optional(),
  // undefined = leave the column alone; null = clear; string = set.
  categoryId: z.string().uuid().nullable().optional(),
  creditorId: z.string().uuid().nullable().optional(),
  paymentMethodId: z.string().uuid().nullable().optional(),
  subtypeId: z.string().uuid().nullable().optional(),
  businessUnitId: z.string().uuid().nullable().optional(),
  reference: z.string().trim().max(80).nullable().optional(),
  autoMatchPatterns: z.array(AutoMatchPattern).max(5).optional(),
});

export const SetClassificationInput = z.object({
  id: z.string().uuid(),
  // undefined = leave the column alone; null = clear; string = set.
  categoryId: z.string().uuid().nullable().optional(),
  creditorId: z.string().uuid().nullable().optional(),
  paymentMethodId: z.string().uuid().nullable().optional(),
  subtypeId: z.string().uuid().nullable().optional(),
  businessUnitId: z.string().uuid().nullable().optional(),
});

export const SetAccrualDateInput = z.object({
  id: z.string().uuid(),
  accrualDate: z.string().date(),
});

export const SetReferenceInput = z.object({
  id: z.string().uuid(),
  // null clears; trimmed and capped at 80 to match the column.
  reference: z.string().trim().max(80).nullable(),
});

export const ResolveRowTarget = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("lov-system"), type: z.string().min(1).max(50) }),
  z.object({ kind: z.literal("tenant-value"), tvKind: z.string().min(1).max(50) }),
]);

export const ResolveRowInput = z.object({
  importRowId: z.string().uuid(),
  target: ResolveRowTarget,
  candidate: z.string(),
});

export const ReviewBulkInput = z.object({
  rowIds: z.array(z.string().uuid()).min(1).max(500),
  action: z.enum(["new", "skip"]),
});

export const ListImportRowsInput = z.object({
  importId: z.string().uuid(),
  status: z.string().optional(),
});
