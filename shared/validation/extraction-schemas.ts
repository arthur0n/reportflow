// shared/validation/extraction-schemas.ts
//
// tRPC inputs for the extraction hop and its repair screen (decisions §4,
// §4.2). Every id here is a server-issued uuid the client only echoes back —
// nothing in this file lets the browser name a new object, a template, a
// model or an S3 key.
//
// `CorrectExtractionInput.data` is deliberately shapeless. The shape it must
// have is the FROZEN FIELD LIST, which lives in the database and differs per
// document type — a static schema here could only be a weaker second opinion.
// The server loads the list and runs `validateExtraction`
// (./extraction-validation.ts), which is the same check the collector applies
// to the model's own answer. What this schema does is bound the payload
// (`z.record` of a JSON object) so a malformed body is refused before any of
// that runs.

import { z } from "zod/v4";

export const StartExtractionInput = z.object({
  documentId: z.string().uuid(),
});
export type StartExtractionInputT = z.infer<typeof StartExtractionInput>;

export const GetExtractionInput = z.object({
  documentId: z.string().uuid(),
});
export type GetExtractionInputT = z.infer<typeof GetExtractionInput>;

/**
 * Keyed on the DOCUMENT, not on an extraction id, and that is not a shortcut.
 * A document in `revisar` has NO extractions row yet: the collector refuses to
 * cache a payload that fails the frozen list (api/collector/collect.ts), so
 * the only thing that exists at repair time is the model's raw answer on
 * `report_jobs.result`. The correction is what CREATES the row — asking the
 * client to name one first would be asking it to name something that does not
 * exist in the exact case this screen was built for.
 */
export const CorrectExtractionInput = z.object({
  documentId: z.string().uuid(),
  data: z.record(z.string(), z.unknown()),
});
export type CorrectExtractionInputT = z.infer<typeof CorrectExtractionInput>;
