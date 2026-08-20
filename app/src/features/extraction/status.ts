// app/src/features/extraction/status.ts
//
// §4.2's five extraction states, in the words the account reads.
//
// The SERVER returns the pipeline's own vocabulary (`idle` / `running` /
// `revisar` / `done` / `failed`, api/services/extraction-service.ts) and never
// a label: a status column that shipped pt-BR strings from a Lambda would be a
// second place to change the wording, and the two would drift the first time
// someone edited only one. So the translation lives here, once, and both
// screens that show a status import it.

import type { TrpcOutput } from "@/shared/lib/trpc";

export type ExtractionStatus = TrpcOutput["extractions"]["get"]["status"];

export const EXTRACTION_STATUS_LABEL: Record<ExtractionStatus, string> = {
  idle: "aguardando",
  running: "extraindo",
  revisar: "revisar",
  done: "concluído",
  failed: "falhou",
};

export type ExtractionStatusVariant = "outline" | "accent" | "warning" | "success" | "destructive";

/** `revisar` is `warning`, not `destructive`: nothing is broken, somebody is
 * needed. `failed` is destructive — that one IS over (§4.2's `revisar` exists
 * precisely so that an extraction rarely reaches `failed`). */
export function extractionStatusVariant(status: ExtractionStatus): ExtractionStatusVariant {
  switch (status) {
    case "idle":
      return "outline";
    case "running":
      return "accent";
    case "revisar":
      return "warning";
    case "done":
      return "success";
    case "failed":
      return "destructive";
  }
}
