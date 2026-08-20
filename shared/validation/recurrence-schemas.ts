import { z } from "zod/v4";
import { CreateTransactionInput } from "./transaction-schemas";

export const RecurrenceModeSchema = z.enum(["finite", "always"]);
export type RecurrenceMode = z.infer<typeof RecurrenceModeSchema>;

// Cadence is delegated to a system RECURRENCE_PATTERN LOV row whose
// `description` column carries the iCalendar RRULE string. Mode + repeatCount
// are orchestration concerns (how many siblings to materialize now), kept
// separate from the rrule so a single pattern is reusable across recurrences.
export const RecurrenceConfigSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("finite"),
    recurrencePatternId: z.string().uuid(),
    repeatCount: z.number().int().min(1).max(120),
  }),
  z.object({
    mode: z.literal("always"),
    recurrencePatternId: z.string().uuid(),
  }),
]);
export type RecurrenceConfig = z.infer<typeof RecurrenceConfigSchema>;

export const CreateWithRecurrenceInput = z.object({
  // The committed source — a regular CreateTransactionInput payload. The
  // mutation inserts this first as a CERTO/REVISAR/ESTIMADO row depending on
  // status defaulting (`api/services/transactions-write.ts`).
  source: CreateTransactionInput,
  // Omit to behave as a plain create ("Don't repeat" path).
  recurrence: RecurrenceConfigSchema.optional(),
  // When set, after creating the source the mutation marks this import row
  // reviewed_matched against it — same shape as Conciliar.
  importRowId: z.string().uuid().optional(),
});
