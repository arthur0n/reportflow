import { trpc, type TrpcOutput } from "@/shared/lib/trpc";

export type DocumentTypeOption = TrpcOutput["documents"]["documentTypes"][number];

/**
 * The tenant's active document types, labelled for the tier-3 dropdown
 * (decisions §3.3) — the same `"{provider} / {name}"` label tier 2's
 * classification job shows the model (api/detection/classify-job.ts), so the
 * option a human picks and the option the model could have picked line up.
 */
export function useDocumentTypes(): {
  options: DocumentTypeOption[];
  isLoading: boolean;
} {
  const q = trpc.documents.documentTypes.useQuery(undefined, { staleTime: 60 * 1000 });
  return { options: q.data ?? [], isLoading: q.isLoading };
}
