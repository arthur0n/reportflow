import { type ReactElement, useState } from "react";
import { Link, useParams } from "wouter";
import { ChevronRight } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { ImportStatusBadge } from "@/components/imports/ImportStatusBadge";
import { ReviewRows, type ImportRowData } from "@/components/imports/ReviewRows";
import {
  ImportStepper,
  type ImportStep,
  type StepperStep,
} from "@/components/imports/ImportStepper";
import { ImportSummary } from "@/components/imports/ImportSummary";
import { StatementValuesTable } from "@/components/imports/StatementValuesTable";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Eyebrow } from "@/components/ui/eyebrow";
import { trpc } from "@/shared/lib/trpc";
import { formatDate } from "@/shared/lib/format";

// ---------------------------------------------------------------------------
// Error rows section
// ---------------------------------------------------------------------------

function ErrorRows({ errorRows }: { errorRows: ImportRowData[] }): ReactElement | null {
  const utils = trpc.useUtils();
  const invalidate = (): void => {
    void utils.statementImportRows.list.invalidate();
    void utils.statementImports.get.invalidate();
  };
  const updateMutation = trpc.statementImportRows.update.useMutation({ onSuccess: invalidate });
  const deleteMutation = trpc.statementImportRows.delete.useMutation({ onSuccess: invalidate });

  if (errorRows.length === 0) return null;

  return (
    <Collapsible defaultOpen className="mt-6">
      <CollapsibleTrigger className="group flex items-center gap-2 mb-3 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]">
        <ChevronRight className="h-3.5 w-3.5 text-[color:var(--ink-mute)] transition-transform duration-200 group-data-[state=open]:rotate-90" />
        <span className="text-[length:var(--fs-eyebrow)] uppercase tracking-[0.14em] font-[550] text-[color:var(--negative)]">
          Erros para corrigir
        </span>
        <span className="tabular-nums text-[length:var(--fs-eyebrow)] text-[color:var(--ink-mute)]">
          · {errorRows.length}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>Erro</TableHead>
              <TableHead>Data</TableHead>
              <TableHead>Valor</TableHead>
              <TableHead>Descrição</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {errorRows.map((row) => (
              <ErrorRowEditor
                key={row.id}
                row={row}
                onSave={(patch) => {
                  updateMutation.mutate({ id: row.id, ...patch });
                }}
                onDelete={() => {
                  deleteMutation.mutate(row.id);
                }}
              />
            ))}
          </TableBody>
        </Table>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ErrorRowEditor({
  row,
  onSave,
  onDelete,
}: {
  row: ImportRowData;
  onSave: (patch: { actualDate?: string; actualAmount?: number; description?: string }) => void;
  onDelete: () => void;
}): ReactElement {
  const [date, setDate] = useState(row.actualDate ?? "");
  const [amount, setAmount] = useState(
    row.actualAmount !== null ? (Number(row.actualAmount) / 100).toString() : "",
  );
  const [desc, setDesc] = useState(row.description ?? "");

  return (
    <TableRow>
      <TableCell className="text-[length:var(--fs-eyebrow)] text-[color:var(--ink-mute)] tabular-nums">
        {String(row.lineNumber).padStart(3, "0")}
      </TableCell>
      <TableCell className="text-[length:var(--fs-body-sm)] text-[color:var(--negative)] italic">
        {row.errorDetail}
      </TableCell>
      <TableCell>
        <Input
          type="date"
          value={date}
          onChange={(e) => {
            setDate(e.target.value);
          }}
          className="h-8 text-[length:var(--fs-body-sm)] w-32"
        />
      </TableCell>
      <TableCell>
        <Input
          type="number"
          step="0.01"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
          }}
          className="h-8 text-[length:var(--fs-body-sm)] w-24 text-right"
        />
      </TableCell>
      <TableCell>
        <Input
          value={desc}
          onChange={(e) => {
            setDesc(e.target.value);
          }}
          className="h-8 text-[length:var(--fs-body-sm)] w-48"
        />
      </TableCell>
      <TableCell>
        <div className="flex gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const patch: {
                actualDate?: string;
                actualAmount?: number;
                description?: string;
              } = {};
              if (date.length > 0) patch.actualDate = date;
              if (amount.length > 0) patch.actualAmount = Math.round(parseFloat(amount) * 100);
              if (desc.length > 0) patch.description = desc;
              onSave(patch);
            }}
          >
            Salvar
          </Button>
          <Button variant="ghost" size="sm" onClick={onDelete}>
            Excluir
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

// ---------------------------------------------------------------------------
// Import header
// ---------------------------------------------------------------------------

function ImportHeader({
  imp,
}: {
  imp: {
    fileName: string;
    status: string;
    sourceFormat: string | null;
    bankSlug: string | null;
    periodStart: string | null;
    periodEnd: string | null;
    errorMessage: string | null;
    approvedAt: string | null;
  };
}): ReactElement {
  return (
    <>
      <PageHeader
        eyebrow="Importação"
        title={imp.fileName}
        lede={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <ImportStatusBadge status={imp.status} />
            {imp.sourceFormat !== null && (
              <span className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)] uppercase tracking-[0.1em]">
                {imp.sourceFormat}
              </span>
            )}
            {imp.bankSlug !== null && (
              <span className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)]">
                · {imp.bankSlug}
              </span>
            )}
            {imp.periodStart !== null && imp.periodEnd !== null && (
              <span className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)] tabular-nums">
                · {formatDate(imp.periodStart)} — {formatDate(imp.periodEnd)}
              </span>
            )}
          </span>
        }
      />

      {imp.status === "parse_failed" && (
        <div className="border-l-2 border-[color:var(--negative)] pl-4 py-2">
          <Eyebrow tone="negative">Falha ao processar</Eyebrow>
          <p className="text-[length:var(--fs-body-sm)] text-[color:var(--negative)] mt-1">
            {imp.errorMessage ?? "Erro desconhecido."}
          </p>
        </div>
      )}

      {imp.status === "approved" && (
        <div className="border-l-2 border-[color:var(--positive)] pl-4 py-2">
          <Eyebrow tone="positive">Aprovada</Eyebrow>
          <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)] mt-1">
            Importação aprovada em{" "}
            <span className="tabular-nums">{formatDate(imp.approvedAt)}</span>.
          </p>
        </div>
      )}

      {imp.status === "rejected" && (
        <div className="border-l-2 border-[color:var(--caution)] pl-4 py-2">
          <Eyebrow>Rejeitada</Eyebrow>
          <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)] mt-1 italic">
            Importação descartada. O arquivo pode ser reenviado.
          </p>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

function computeStep(args: {
  status: string;
  errorCount: number;
  reviewableCount: number;
}): ImportStep {
  const { status, errorCount, reviewableCount } = args;
  if (status === "uploaded_pending" || status === "parsing") return "upload";
  if (status === "approved") return "done";
  if (status === "parsed" && errorCount === 0 && reviewableCount === 0) return "summary";
  return "review";
}

const REVIEWED_STATUSES = ["reviewed_new", "reviewed_matched", "reviewed_skip", "deleted"];

function deriveRowGroups(rows: ImportRowData[]): {
  errorRows: ImportRowData[];
  reviewableRows: ImportRowData[];
  reviewedRows: ImportRowData[];
  summaryCounts: { new: number; matched: number; skipped: number; deleted: number };
} {
  const reviewedRows = rows.filter((r) => REVIEWED_STATUSES.includes(r.status));
  return {
    errorRows: rows.filter((r) => r.status === "parsed_error"),
    reviewableRows: rows.filter((r) => ["parsed_ok", "edited"].includes(r.status)),
    reviewedRows,
    summaryCounts: {
      new: reviewedRows.filter((r) => r.status === "reviewed_new").length,
      matched: reviewedRows.filter((r) => r.status === "reviewed_matched").length,
      skipped: reviewedRows.filter((r) => r.status === "reviewed_skip").length,
      deleted: reviewedRows.filter((r) => r.status === "deleted").length,
    },
  };
}

function ApproveResultBanner({
  result,
}: {
  result: { created: number; matched: number; skipped: number };
}): ReactElement {
  return (
    <div className="border-l-2 border-[color:var(--positive)] pl-4 py-2">
      <Eyebrow tone="positive">Resultado</Eyebrow>
      <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)] mt-1">
        <span className="tabular-nums font-[500] text-[color:var(--ink)]">{result.created}</span>{" "}
        nova{result.created === 1 ? "" : "s"} ·{" "}
        <span className="tabular-nums font-[500] text-[color:var(--ink)]">{result.matched}</span>{" "}
        conciliada{result.matched === 1 ? "" : "s"} ·{" "}
        <span className="tabular-nums font-[500] text-[color:var(--ink)]">{result.skipped}</span>{" "}
        pulada{result.skipped === 1 ? "" : "s"}.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card import view — acquirer reports promote straight into acquirer_sales
// at parse time (G-02); the work continues on the conciliation page.
// ---------------------------------------------------------------------------

const CARD_STEPS: StepperStep[] = [
  { key: "upload", label: "Enviar" },
  { key: "saved", label: "Salvar" },
  { key: "conciliation", label: "Conciliação" },
];

function CardImportView({
  imp,
  hideStepper,
}: {
  imp: Parameters<typeof ImportHeader>[0]["imp"] & { status: string; rowsTotal: number };
  hideStepper: boolean;
}): ReactElement {
  const cardStep =
    imp.status === "uploaded_pending" || imp.status === "parsing" ? "upload" : "conciliation";

  return (
    <AppLayout>
      <ImportHeader imp={imp} />

      {!hideStepper && <ImportStepper currentStep={cardStep} steps={CARD_STEPS} />}

      {imp.status === "parsed" && (
        <div className="border-l-2 border-[color:var(--positive)] pl-4 py-2">
          <Eyebrow tone="positive">Vendas salvas</Eyebrow>
          <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)] mt-1">
            <span className="tabular-nums font-[500] text-[color:var(--ink)]">{imp.rowsTotal}</span>{" "}
            linha{imp.rowsTotal === 1 ? "" : "s"} de vendas registrada
            {imp.rowsTotal === 1 ? "" : "s"} e conciliação executada.
          </p>
          <Link
            href="/conciliation"
            className="inline-flex items-center gap-1.5 mt-2 text-[length:var(--fs-body-sm)] font-[550] text-[color:var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] rounded-sm"
          >
            Ir para conciliação <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      )}
    </AppLayout>
  );
}

// Values first, review as an explicit action: the user sees the statement's
// rows and totals without touching classification; "Revisar e aprovar" opens
// the existing review flow that saves rows into transactions.
function BankImportBody({
  view,
  setView,
  currentStep,
  rows,
  errorRows,
  reviewableRows,
  reviewedRows,
}: {
  view: "values" | "review";
  setView: (v: "values" | "review") => void;
  currentStep: ImportStep;
  rows: Parameters<typeof StatementValuesTable>[0]["rows"];
  errorRows: ImportRowData[];
  reviewableRows: ImportRowData[];
  reviewedRows: ImportRowData[];
}): ReactElement | null {
  if (currentStep !== "review" && currentStep !== "done") return null;

  if (view === "values" || currentStep === "done") {
    return (
      <>
        {currentStep === "review" && (
          <div className="flex items-center gap-3">
            <Button
              onClick={() => {
                setView("review");
              }}
            >
              Revisar e aprovar
            </Button>
            <span className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
              Classifique e aprove quando quiser levar as linhas para os lançamentos.
            </span>
          </div>
        )}
        <StatementValuesTable rows={rows} />
      </>
    );
  }

  return (
    <>
      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setView("values");
          }}
        >
          Voltar para valores
        </Button>
      </div>
      <ErrorRows errorRows={errorRows} />
      <ReviewRows reviewableRows={reviewableRows} reviewedRows={reviewedRows} />
    </>
  );
}

export function ImportDetailPage(): ReactElement {
  const params = useParams<{ id: string }>();
  const utils = trpc.useUtils();
  const importId = params.id;

  const importQuery = trpc.statementImports.get.useQuery(importId, {
    enabled: importId.length > 0,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === undefined) return false;
      return ["uploaded_pending", "parsing"].includes(status) ? 2000 : false;
    },
  });

  const isCard = importQuery.data?.sourceKind === "card";

  const rowsQuery = trpc.statementImportRows.list.useQuery(
    { importId },
    {
      enabled:
        importId.length > 0 &&
        ["parsed", "approved"].includes(importQuery.data?.status ?? "") &&
        !isCard,
    },
  );

  // Values first: the user sees what the statement contains before deciding
  // to classify/approve anything. Review is an action, not a gate.
  const [view, setView] = useState<"values" | "review">("values");

  const invalidateImport = (): void => {
    void utils.statementImports.get.invalidate();
    void utils.statementImports.list.invalidate();
  };

  const approveMutation = trpc.statementImports.approve.useMutation({
    onSuccess: invalidateImport,
  });

  const rejectMutation = trpc.statementImports.reject.useMutation({
    onSuccess: invalidateImport,
  });

  if (importQuery.isLoading) {
    return (
      <AppLayout>
        <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">Carregando…</p>
      </AppLayout>
    );
  }

  if (importQuery.error !== null || !importQuery.data) {
    return (
      <AppLayout>
        <p className="text-[length:var(--fs-body-sm)] text-[color:var(--negative)]">
          {importQuery.error?.message ?? "Importação não encontrada."}
        </p>
      </AppLayout>
    );
  }

  const imp = importQuery.data;
  const { errorRows, reviewableRows, reviewedRows, summaryCounts } = deriveRowGroups(
    rowsQuery.data ?? [],
  );

  const currentStep = computeStep({
    status: imp.status,
    errorCount: errorRows.length,
    reviewableCount: reviewableRows.length,
  });

  const hideStepper = imp.status === "parse_failed" || imp.status === "rejected";

  const approveResult = approveMutation.data;

  if (isCard) {
    return <CardImportView imp={imp} hideStepper={hideStepper} />;
  }

  return (
    <AppLayout>
      <ImportHeader imp={imp} />

      {!hideStepper && <ImportStepper currentStep={currentStep} />}

      {currentStep === "done" && approveResult !== undefined && (
        <ApproveResultBanner result={approveResult} />
      )}

      <BankImportBody
        view={view}
        setView={setView}
        currentStep={currentStep}
        rows={rowsQuery.data ?? []}
        errorRows={errorRows}
        reviewableRows={reviewableRows}
        reviewedRows={reviewedRows}
      />

      {currentStep === "summary" && (
        <ImportSummary
          counts={summaryCounts}
          isApproving={approveMutation.isPending}
          isRejecting={rejectMutation.isPending}
          approveError={approveMutation.error?.message ?? null}
          onApprove={() => {
            approveMutation.mutate(imp.id);
          }}
          onReject={() => {
            rejectMutation.mutate(imp.id);
          }}
        />
      )}
    </AppLayout>
  );
}
