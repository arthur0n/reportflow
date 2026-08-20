// app/src/pages/CalibratePage.tsx
//
// Calibrate (decisions §3.1, §3.3, §12.8). One screen, three steps, in the
// order §4's core pattern names them: AI proposes → human confirms → frozen →
// runs unattended.
//
//   1. pick a provider and a sample document that is already uploaded
//   2. [Propor campos] — one relay hop, polled through the SAME `jobs.poll`
//      backstop every other async screen here uses
//   3. edit the draft and [Congelar]
//
// Nothing between 2 and 3 is stored. That is the whole point of the human
// step: a proposal that persisted itself would make the frozen field list a
// model's opinion, inherited unattended by every later extraction.

import { useEffect, useState, type ReactElement } from "react";
import { toast } from "sonner";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { Section } from "@/components/ui/section";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
import {
  CalibrationDraftForm,
  type CalibrationDraft,
} from "@/features/calibration/CalibrationDraftForm";
import type { DraftChild, DraftField } from "@/features/calibration/FieldListEditor";
import { LEAF_FIELD_TYPES, isContainerType } from "@shared/validation/field-spec";

const NEW_PROVIDER = "__new__";

type ProposalOutcome = TrpcOutput["calibration"]["pollProposal"];
type ProposedFields = Extract<ProposalOutcome, { status: "ready" }>["proposal"]["fields"];

function isLeafType(type: string): type is DraftChild["type"] {
  return (LEAF_FIELD_TYPES as readonly string[]).includes(type);
}

/** The wire proposal → the editor's mutable draft. Children that came back
 * with a container type are dropped rather than rendered as an un-editable
 * row: the editor offers exactly one level of nesting, and a silently broken
 * row is worse than a missing one a human can re-add. */
function toDraftFields(fields: ProposedFields): DraftField[] {
  return fields.map((f) => ({
    name: f.name,
    type: f.type,
    required: f.required,
    description: f.description,
    ...(isContainerType(f.type)
      ? {
          fields: (f.fields ?? [])
            .filter((c) => isLeafType(c.type))
            .map((c) => ({
              name: c.name,
              type: isLeafType(c.type) ? c.type : "string",
              required: c.required,
              description: c.description,
            })),
        }
      : {}),
  }));
}

/** The draft → the freeze input. Only the shape changes; every rule about
 * what is acceptable lives in `FreezeCalibrationInput` on the server, which
 * is the copy that has to be right. */
function toFreezeFields(fields: readonly DraftField[]) {
  return fields.map((f) => ({
    name: f.name.trim(),
    type: f.type,
    required: f.required,
    description: f.description.trim(),
    ...(isContainerType(f.type)
      ? {
          fields: (f.fields ?? []).map((c) => ({
            name: c.name.trim(),
            type: c.type,
            required: c.required,
            description: c.description.trim(),
          })),
        }
      : {}),
  }));
}

function parseConfirmedJson(raw: string): Record<string, unknown> | null | "invalid" {
  if (raw.trim().length === 0) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return "invalid";
    }
    return parsed as Record<string, unknown>;
  } catch {
    return "invalid";
  }
}

function FrozenTemplates(): ReactElement {
  const query = trpc.calibration.listTemplates.useQuery();
  const templates = query.data ?? [];

  return (
    <Section
      eyebrow="§12.8"
      title="Templates congelados"
      description="Um template vivo por tipo de documento. Recalibrar substitui, nunca bifurca."
    >
      {templates.length === 0 ? (
        <p className="py-6 text-[length:var(--fs-body-sm)] italic text-[color:var(--ink-mute)]">
          Nenhum template congelado ainda.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Fornecedor / Tipo</TableHead>
              <TableHead>Modo</TableHead>
              <TableHead>Geração</TableHead>
              <TableHead>Pistas</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {templates.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="font-[500] text-[color:var(--ink)]">
                  {t.providerName} / {t.typeName}
                </TableCell>
                <TableCell>{t.inputMode}</TableCell>
                <TableCell className="tabular-nums">rev {t.calibrationRev}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1.5">
                    {t.detectHint.map((h) => (
                      <Badge key={h} variant="outline">
                        {h}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

export function CalibratePage(): ReactElement {
  const utils = trpc.useUtils();
  const providersQuery = trpc.calibration.providers.useQuery();
  const documentsQuery = trpc.documents.list.useQuery();

  const [providerChoice, setProviderChoice] = useState<string>(NEW_PROVIDER);
  const [newProviderName, setNewProviderName] = useState("");
  const [documentTypeName, setDocumentTypeName] = useState("");
  const [sampleDocumentId, setSampleDocumentId] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [draft, setDraft] = useState<CalibrationDraft | null>(null);

  const proposal = trpc.calibration.pollProposal.useQuery(
    { jobId: jobId ?? "" },
    {
      enabled: jobId !== null && draft === null,
      refetchInterval: (query) => (query.state.data?.status === "pending" ? 1500 : false),
    },
  );

  useEffect(() => {
    const data = proposal.data;
    if (data === undefined || draft !== null) return;
    if (data.status === "ready") {
      setDraft({
        documentTypeName:
          documentTypeName.trim().length > 0
            ? documentTypeName.trim()
            : data.proposal.documentTypeName,
        inputMode: data.proposal.inputMode,
        detectHint: [...data.proposal.detectHint],
        fields: toDraftFields(data.proposal.fields),
        sampleValuesJson: data.proposal.sampleValuesJson ?? "",
      });
    } else if (data.status === "failed" || data.status === "unreadable") {
      toast.error(data.error);
      setJobId(null);
    }
    // The settled proposal is the only thing that should seed the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal.data?.status]);

  const propose = trpc.calibration.propose.useMutation({
    onSuccess: (out) => {
      setDraft(null);
      setJobId(out.jobId);
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const freeze = trpc.calibration.freeze.useMutation({
    onSuccess: (out) => {
      toast.success(
        out.recalibrated
          ? `Recalibrado — geração ${String(out.calibrationRev)}, ${String(out.fieldCount)} campos. Extrações anteriores ficaram obsoletas.`
          : `Congelado — ${String(out.fieldCount)} campos.`,
      );
      if (!out.fixtureJsonStored && out.fixtureJsonSkippedReason !== undefined) {
        toast.info(`Fixture sem JSON: ${out.fixtureJsonSkippedReason}`);
      }
      setDraft(null);
      setJobId(null);
      void utils.calibration.listTemplates.invalidate();
      void utils.documents.documentTypes.invalidate();
      void utils.calibration.providers.invalidate();
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const onFreeze = (): void => {
    if (draft === null || sampleDocumentId === null) return;
    const confirmed = parseConfirmedJson(draft.sampleValuesJson);
    if (confirmed === "invalid") {
      toast.error("O JSON do exemplar não é um objeto JSON válido.");
      return;
    }
    freeze.mutate({
      provider:
        providerChoice === NEW_PROVIDER ? { name: newProviderName.trim() } : { id: providerChoice },
      documentType: { name: draft.documentTypeName.trim() },
      sampleDocumentId,
      inputMode: draft.inputMode,
      detectHint: draft.detectHint.map((h) => h.trim()).filter((h) => h.length > 0),
      fields: toFreezeFields(draft.fields),
      ...(confirmed === null ? {} : { confirmedJson: confirmed }),
    });
  };

  const documents = documentsQuery.data ?? [];
  const canPropose =
    sampleDocumentId !== null &&
    (providerChoice !== NEW_PROVIDER || newProviderName.trim().length > 0) &&
    !propose.isPending &&
    jobId === null;

  return (
    <AppLayout>
      <PageHeader
        eyebrow="Calibração"
        title="Calibrar"
        lede="Envie uma amostra, a IA propõe a lista de campos, você corrige e congela. Depois disso a extração roda sozinha."
      />

      <Section eyebrow="Passo 1" title="Amostra">
        <div className="flex flex-wrap items-end gap-6">
          <div className="flex flex-col gap-1.5">
            <Label>Fornecedor</Label>
            <Select value={providerChoice} onValueChange={setProviderChoice}>
              <SelectTrigger className="w-[240px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NEW_PROVIDER}>+ Novo fornecedor</SelectItem>
                {(providersQuery.data ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {providerChoice === NEW_PROVIDER && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cal-new-provider">Nome do novo fornecedor</Label>
              <Input
                id="cal-new-provider"
                className="w-[240px]"
                value={newProviderName}
                onChange={(e) => {
                  setNewProviderName(e.target.value);
                }}
              />
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label>Documento de amostra</Label>
            <Select
              {...(sampleDocumentId !== null ? { value: sampleDocumentId } : {})}
              onValueChange={setSampleDocumentId}
            >
              <SelectTrigger className="w-[320px]">
                <SelectValue placeholder="Selecionar documento" />
              </SelectTrigger>
              <SelectContent>
                {documents.map((doc) => (
                  <SelectItem key={doc.id} value={doc.id}>
                    {doc.fileName ?? doc.s3Key}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cal-type-hint">Tipo de documento (opcional)</Label>
            <Input
              id="cal-type-hint"
              className="w-[240px]"
              placeholder="Nota Fiscal"
              value={documentTypeName}
              onChange={(e) => {
                setDocumentTypeName(e.target.value);
              }}
            />
          </div>

          <Button
            disabled={!canPropose}
            onClick={() => {
              if (sampleDocumentId === null) return;
              propose.mutate({
                documentId: sampleDocumentId,
                ...(providerChoice === NEW_PROVIDER ? {} : { providerId: providerChoice }),
                ...(documentTypeName.trim().length > 0
                  ? { documentTypeName: documentTypeName.trim() }
                  : {}),
              });
            }}
          >
            Propor campos
          </Button>
        </div>

        {jobId !== null && draft === null && (
          <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
            Lendo a amostra…
          </p>
        )}
        {documentsQuery.isLoading && (
          <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
            Carregando documentos…
          </p>
        )}
      </Section>

      {draft !== null && (
        <CalibrationDraftForm
          draft={draft}
          onChange={setDraft}
          onFreeze={onFreeze}
          freezing={freeze.isPending}
        />
      )}

      <FrozenTemplates />
    </AppLayout>
  );
}
