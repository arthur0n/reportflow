// shared/validation/conciliation-schemas.ts
//
// Inputs for the G-02 conciliation router.

import { z } from "zod/v4";

export const SaleBucket = z.enum(["all", "pending", "matched", "ignored"]);

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const ListSalesInput = z.object({
  bucket: SaleBucket,
  acquirerId: z.string().uuid().optional(),
  search: z.string().trim().max(120).optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
});

export const ListUnmatchedDepositsInput = z.object({
  search: z.string().trim().max(120).optional(),
  from: IsoDate.optional(),
  to: IsoDate.optional(),
});

export const ListStatementRowsInput = z.object({
  from: IsoDate,
  to: IsoDate,
});

export const RunMatchingInput = z.object({
  acquirerId: z.string().uuid().optional(),
});

export const MatchManuallyInput = z.object({
  saleIds: z.array(z.string().uuid()).min(1).max(200),
  depositRowId: z.string().uuid(),
});

export const SaleIdInput = z.object({ id: z.string().uuid() });

export type ListSalesInputType = z.infer<typeof ListSalesInput>;
