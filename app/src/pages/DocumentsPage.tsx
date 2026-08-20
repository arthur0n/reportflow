// app/src/pages/DocumentsPage.tsx
//
// Minimal documents surface — NOT the full documents UX. It exists to satisfy
// decisions §3.3's one hard requirement: the detected document type is
// "always shown and always correctable" before extraction runs. So this page
// is a list of what has already been uploaded/confirmed
// (`documents.confirmUpload`, wired elsewhere) with, per row:
//
//   * a badge for how the type got there (hint / model / manual / not yet)
//   * a dropdown, ALWAYS present, prefilled with the current type, and never
//     disabled — picking a value calls `setDocumentType` (tier 3) regardless
//     of what tiers 1/2 answered
//   * a "Detectar tipo" trigger for a document with no type yet, since there
//     is no upload flow in this app to fire it automatically post-confirm
//
// Upload itself (presigned POST, drag-and-drop, …) is out of scope here —
// this page assumes documents already exist.

import { useEffect, useState, type ReactElement } from "react";
import { toast } from "sonner";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { trpc, type TrpcOutput } from "@/shared/lib/trpc";
import { useDocumentTypes, type DocumentTypeOption } from "@/hooks/use-document-types";

type DocumentRow = TrpcOutput["documents"]["list"][number];

/** How the type got onto the document, or that it hasn't yet (§3.3's three
 * tiers, plus "nothing has run"). */
function DetectionBadge({ detectedBy }: { detectedBy: string | null }): ReactElement {
  if (detectedBy === "manual") {
    return <Badge variant="secondary">Selecionado manualmente</Badge>;
  }
  if (detectedBy === "hint" || detectedBy === "model") {
    return <Badge variant="accent">Detectado automaticamente</Badge>;
  }
  return <Badge variant="outline">Não detectado</Badge>;
}

function DetectionCell({
  doc,
  options,
}: {
  doc: DocumentRow;
  options: DocumentTypeOption[];
}): ReactElement {
  const utils = trpc.useUtils();
  const [pollingJobId, setPollingJobId] = useState<string | null>(null);

  const applyDetection = trpc.documents.applyDetection.useMutation({
    onSuccess: (outcome) => {
      setPollingJobId(null);
      if (outcome.outcome === "applied") {
        toast.success("Tipo detectado automaticamente.");
      } else if (outcome.outcome === "unresolved") {
        toast.info("Não foi possível classificar automaticamente — selecione o tipo abaixo.");
      }
      void utils.documents.list.invalidate();
    },
    onError: (err) => {
      setPollingJobId(null);
      toast.error(err.message);
    },
  });

  // Poll backstop (decisions §4.1) — same shape every other job-driven screen
  // in this codebase would use: read the row, and once it is no longer
  // `pending`, resolve it onto the document.
  const poll = trpc.jobs.poll.useQuery(
    { id: pollingJobId ?? "" },
    {
      enabled: pollingJobId !== null,
      refetchInterval: (query) => (query.state.data?.status === "pending" ? 1500 : false),
    },
  );

  useEffect(() => {
    if (pollingJobId === null) return;
    if (poll.data !== undefined && poll.data.status !== "pending") {
      applyDetection.mutate({ jobId: pollingJobId });
    }
    // Only the settled status should trigger the apply call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll.data?.status, pollingJobId]);

  const detect = trpc.documents.detect.useMutation({
    onSuccess: (outcome) => {
      if (outcome.outcome === "hint") {
        toast.success("Tipo detectado automaticamente.");
        void utils.documents.list.invalidate();
      } else if (outcome.outcome === "job") {
        setPollingJobId(outcome.jobId);
      } else {
        toast.info("Nenhum tipo de documento configurado para classificar automaticamente.");
      }
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const setDocumentType = trpc.documents.setDocumentType.useMutation({
    onSuccess: () => {
      toast.success("Tipo de documento atualizado.");
      void utils.documents.list.invalidate();
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const detecting = detect.isPending || pollingJobId !== null;

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <DetectionBadge detectedBy={doc.detectedBy} />

      {/* Tier 3 (§3.3): always present, always editable — regardless of what
          tiers 1/2 answered, or whether they ran at all. */}
      <Select
        {...(doc.documentTypeId !== null ? { value: doc.documentTypeId } : {})}
        onValueChange={(value) => {
          setDocumentType.mutate({ documentId: doc.id, documentTypeId: value });
        }}
        disabled={setDocumentType.isPending}
      >
        <SelectTrigger className="w-[240px]">
          <SelectValue placeholder="Selecionar tipo" />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => (
            <SelectItem key={opt.id} value={opt.id}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {doc.documentTypeId === null && (
        <Button
          variant="outline"
          size="sm"
          disabled={detecting}
          onClick={() => {
            detect.mutate({ documentId: doc.id });
          }}
        >
          {detecting ? "Detectando…" : "Detectar tipo"}
        </Button>
      )}
    </div>
  );
}

export function DocumentsPage(): ReactElement {
  const listQuery = trpc.documents.list.useQuery();
  const { options } = useDocumentTypes();
  const documents = listQuery.data ?? [];

  return (
    <AppLayout>
      <PageHeader
        eyebrow="Pipeline"
        title="Documentos"
        lede="Tipo detectado automaticamente quando possível — sempre visível e corrigível antes da extração."
      />

      {listQuery.isLoading && (
        <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">Carregando…</p>
      )}
      {listQuery.error && (
        <p className="text-[length:var(--fs-body-sm)] text-[color:var(--negative)]">
          Erro: {listQuery.error.message}
        </p>
      )}
      {!listQuery.isLoading && documents.length === 0 && (
        <p className="py-10 text-[length:var(--fs-body-sm)] italic text-[color:var(--ink-mute)]">
          Nenhum documento enviado.
        </p>
      )}

      {documents.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Arquivo</TableHead>
              <TableHead>Tipo de documento</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {documents.map((doc) => (
              <TableRow key={doc.id}>
                <TableCell className="font-[500] text-[color:var(--ink)]">
                  {doc.fileName ?? doc.s3Key}
                </TableCell>
                <TableCell>
                  <DetectionCell doc={doc} options={options} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </AppLayout>
  );
}
