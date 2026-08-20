// app/src/features/extraction/RevisarPage.tsx
//
// §4.2's repair screen. "`revisar` opens a field-by-field screen: every value
// shown, problems flagged, all editable. The corrected extraction is persisted
// and never re-run — the fix is permanent and free."
//
// THE SCREEN IS REACHABLE IN EVERY STATE, not only in `revisar`. That is the
// §3.3 lesson applied one hop later: a silent misdetection produces "a
// fully-populated, entirely plausible, completely wrong extraction — the worst
// failure mode in the system, because nothing surfaces it". A validated
// extraction is exactly that shape when the model read the wrong number off
// the right label, so it says so ("Extração validada automaticamente") and
// still lets a human open every field. Nothing here forces them to.
//
// PROBLEMS ARE RECOMPUTED LOCALLY AS THE HUMAN TYPES, with the SAME function
// the collector used to refuse the payload and the same one `correct` will use
// to accept it (shared/validation/extraction-validation.ts). A screen with its
// own opinion of "valid" is a screen that says "salvo" and then shows an
// error.

import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Link, useParams } from "wouter";
import { toast } from "sonner";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { Section } from "@/components/ui/section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { trpc, type TrpcOutput } from "@/shared/lib/trpc";
import { validateExtraction, type FieldProblem } from "@shared/validation/extraction-validation";
import { ExtractionFieldTable } from "./ExtractionFieldTable";
import { dataToDraft, draftToData, type ObjectDraft } from "./extraction-draft";
import { EXTRACTION_STATUS_LABEL, extractionStatusVariant } from "./status";

type ExtractionView = TrpcOutput["extractions"]["get"];

function StatusLine({ view }: { view: ExtractionView }): ReactElement {
  const validated = view.status === "done" && view.problems.length === 0;
  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <Badge variant={extractionStatusVariant(view.status)}>
        {EXTRACTION_STATUS_LABEL[view.status]}
      </Badge>
      {view.extraction?.corrected === true && <Badge variant="secondary">corrigida</Badge>}
      {validated && view.extraction?.corrected !== true && (
        <span className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)]">
          Extração validada automaticamente — nenhuma revisão foi necessária.
        </span>
      )}
      {view.problems.length > 0 && (
        <span className="text-[length:var(--fs-body-sm)] text-[color:var(--negative)]">
          {String(view.problems.length)} problema(s) a corrigir.
        </span>
      )}
      {view.job?.error !== null && view.job?.error !== undefined && (
        <span className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
          {view.job.error}
        </span>
      )}
    </div>
  );
}

/**
 * Nothing to review at THIS calibration rev — either because the hop has never
 * run, or because §12.8's invalidation caught it mid-flight.
 *
 * The stale case is the one `revisar` a human cannot type their way out of:
 * the values below were read against the PREVIOUS field list and the collector
 * refused to cache them, so the repair is another hop, not another keystroke.
 * Every other `revisar` gets no button here on purpose — §4.2's whole argument
 * is that the free, permanent fix beats paying for a second read.
 */
function StartPanel({
  calibrationRev,
  stale,
  pending,
  onStart,
}: {
  calibrationRev: number;
  stale: boolean;
  pending: boolean;
  onStart: () => void;
}): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
        {stale
          ? `O template foi recalibrado durante esta extração. Os valores abaixo foram lidos com a lista de campos anterior e não foram guardados — extraia novamente na rev ${String(calibrationRev)}.`
          : `Nada extraído nesta calibração (rev ${String(calibrationRev)}).`}
      </p>
      <Button size="sm" disabled={pending} onClick={onStart}>
        {pending ? "Enfileirando…" : stale ? "Extrair novamente" : "Extrair"}
      </Button>
    </div>
  );
}

/**
 * The table plus its one action.
 *
 * FULL VALIDITY IS THE GATE, and it is enforced here as well as on the server
 * (api/services/extraction-service.ts) — not as a second opinion, but as the
 * SAME `validateExtraction` run over the same draft, so the button is disabled
 * for exactly the payloads `correct` would refuse. A screen that let you press
 * Save and then showed an error would be telling you something it already knew.
 */
function EditorPanel({
  fields,
  draft,
  problems,
  saving,
  onChange,
  onSave,
}: {
  fields: ExtractionView["fields"];
  draft: ObjectDraft;
  problems: readonly FieldProblem[];
  saving: boolean;
  onChange: (next: ObjectDraft) => void;
  onSave: (data: Record<string, unknown>) => void;
}): ReactElement {
  const canSave = problems.length === 0;
  return (
    <>
      <ExtractionFieldTable fields={fields} draft={draft} problems={problems} onChange={onChange} />

      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={!canSave || saving}
          onClick={() => {
            onSave(draftToData(fields, draft));
          }}
        >
          {saving ? "Salvando…" : "Salvar correção"}
        </Button>
        {!canSave && (
          <span className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
            Corrija todos os campos marcados para salvar.
          </span>
        )}
      </div>
    </>
  );
}

export function RevisarPage(): ReactElement {
  const params = useParams<{ id: string }>();
  const documentId = params.id;
  const utils = trpc.useUtils();

  const query = trpc.extractions.get.useQuery(
    { documentId },
    {
      // While a hop is in flight the row is the only thing worth reading —
      // the same poll cadence every other job-driven screen here uses (§4.1).
      refetchInterval: (q) => (q.state.data?.status === "running" ? 1500 : false),
    },
  );
  const view = query.data;

  const [draft, setDraft] = useState<ObjectDraft | null>(null);

  // The server payload seeds the draft ONCE per (document, answer). Re-seeding
  // on every refetch would throw away what the human is typing the moment a
  // poll lands; keying on the extraction id + job attempt means a NEW answer
  // (a retry that landed, a correction that saved) does replace it.
  const seedKey = `${view?.extraction?.id ?? "none"}:${String(view?.job?.attempt ?? 0)}:${String(
    view?.status ?? "",
  )}`;
  useEffect(() => {
    if (view === undefined) return;
    setDraft(dataToDraft(view.fields, view.data));
    // seedKey collapses exactly the identity above; `view` itself changes on
    // every poll and must not re-seed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey]);

  const problems = useMemo(() => {
    if (view === undefined || draft === null) return [];
    return validateExtraction(view.fields, draftToData(view.fields, draft)).problems;
  }, [view, draft]);

  const correct = trpc.extractions.correct.useMutation({
    onSuccess: () => {
      toast.success("Correção salva. Esta extração não será refeita.");
      void utils.extractions.get.invalidate({ documentId });
      void utils.extractions.list.invalidate();
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const start = trpc.extractions.start.useMutation({
    onSuccess: (outcome) => {
      toast.info(
        outcome.outcome === "cached"
          ? "Este documento já foi extraído nesta calibração."
          : "Extração enfileirada.",
      );
      void utils.extractions.get.invalidate({ documentId });
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  return (
    <AppLayout>
      <PageHeader
        eyebrow="Pipeline"
        title="Revisar extração"
        lede="Todos os campos da lista congelada, com os valores lidos. Corrija o que estiver marcado — a correção é permanente e não é refeita."
        aside={
          <Link href="/documents">
            <Button variant="outline" size="sm">
              Documentos
            </Button>
          </Link>
        }
      />

      {query.isLoading && (
        <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">Carregando…</p>
      )}
      {query.error && (
        <p className="text-[length:var(--fs-body-sm)] text-[color:var(--negative)]">
          Erro: {query.error.message}
        </p>
      )}

      {view !== undefined && (
        <Section
          {...(view.template === null
            ? {}
            : { eyebrow: `${view.template.providerName} / ${view.template.typeName}` })}
          title={view.document.fileName ?? view.document.s3Key}
        >
          <StatusLine view={view} />

          {view.template === null && (
            <p className="py-6 text-[length:var(--fs-body-sm)] italic text-[color:var(--ink-mute)]">
              Este documento não tem um template de extração congelado. Defina o tipo e calibre-o
              antes de extrair.
            </p>
          )}

          {view.template !== null && (view.status === "idle" || view.staleTemplate) && (
            <StartPanel
              calibrationRev={view.template.calibrationRev}
              stale={view.staleTemplate}
              pending={start.isPending}
              onStart={() => {
                start.mutate({ documentId });
              }}
            />
          )}

          {view.template !== null && draft !== null && view.status !== "idle" && (
            <EditorPanel
              fields={view.fields}
              draft={draft}
              problems={problems}
              saving={correct.isPending}
              onChange={setDraft}
              onSave={(data) => {
                correct.mutate({ documentId, data });
              }}
            />
          )}
        </Section>
      )}
    </AppLayout>
  );
}
