// app/src/features/extraction/ExtractionCell.tsx
//
// The documents list's extraction column (decisions §4, §4.2): where this
// document is in hop 1, and the one action that is available from there.
//
// THE ACTION IS ALWAYS [Extrair] OR NOTHING, never "re-extrair". §12.8 is
// explicit that re-extraction is caused by RECALIBRATION, not by a button: the
// cache key is `(s3_key, calibration_rev)`, so pressing [Extrair] on an
// already-extracted document at the same rev returns the cached row for free —
// which is the correct behaviour and also why a second button offering to
// "refazer" would be a lie. A human who thinks the read is wrong goes to the
// repair screen and fixes the value; a human who thinks the FIELD LIST is
// wrong recalibrates, and the rev bump re-extracts by itself.

import type { ReactElement } from "react";
import { Link } from "wouter";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { trpc, type TrpcOutput } from "@/shared/lib/trpc";
import { EXTRACTION_STATUS_LABEL, extractionStatusVariant } from "./status";

type StatusRow = TrpcOutput["extractions"]["list"][number];

export function ExtractionCell({
  documentId,
  row,
  hasType,
}: {
  documentId: string;
  /** `undefined` when nothing has ever run for this document — the list only
   * carries documents with a job or an extraction. */
  row: StatusRow | undefined;
  /** No document type means nothing to extract AGAINST (§3.3 runs first). The
   * server refuses it too; disabling here is so the refusal is legible before
   * it costs a round trip. */
  hasType: boolean;
}): ReactElement {
  const utils = trpc.useUtils();
  const status = row?.status ?? "idle";

  const start = trpc.extractions.start.useMutation({
    onSuccess: (outcome) => {
      toast.info(
        outcome.outcome === "cached"
          ? "Este documento já foi extraído nesta calibração."
          : "Extração enfileirada.",
      );
      void utils.extractions.list.invalidate();
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <Badge variant={extractionStatusVariant(status)}>{EXTRACTION_STATUS_LABEL[status]}</Badge>
      {row?.corrected === true && <Badge variant="secondary">corrigida</Badge>}

      {/* §12.8's in-flight recalibration is the ONE `revisar` a human cannot
          type their way out of: the values on screen were read against the
          previous field list and nothing was cached. Offering [Extrair] on an
          ordinary `revisar` would invite paying for a second hop instead of
          making the free, permanent fix §4.2 exists for. */}
      {(status === "idle" || status === "failed" || row?.staleTemplate === true) && (
        <Button
          variant="outline"
          size="sm"
          disabled={!hasType || start.isPending}
          title={hasType ? undefined : "Defina o tipo do documento primeiro."}
          onClick={() => {
            start.mutate({ documentId });
          }}
        >
          {start.isPending ? "Enfileirando…" : "Extrair"}
        </Button>
      )}

      {status !== "idle" && status !== "running" && (
        <Link href={`/documentos/${documentId}/revisar`}>
          <Button variant={status === "revisar" ? "default" : "ghost"} size="sm">
            {status === "revisar" ? "Revisar" : "Ver campos"}
          </Button>
        </Link>
      )}
    </div>
  );
}
