// G-02 monthly workspace, driven by the header month selector. Views:
// Conferência (daily grid + deposits without sales), Extrato (bank rows),
// Vendas (acquirer sales), Ignoradas. The stat strip stays one line —
// the data is the page, not the numbers about it.

import { useState, type ReactElement } from "react";
import { Loader2 } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Eyebrow } from "@/components/ui/eyebrow";
import { toast } from "sonner";
import { trpc } from "@/shared/lib/trpc";
import { useImportsBusy } from "@/hooks/use-imports-busy";
import { usePeriod, periodRange } from "@/shared/period";
import { formatCurrency } from "@/shared/lib/format";
import { DailyGrid } from "@/features/conciliation/DailyGrid";
import { VendasMonthTable } from "@/features/conciliation/VendasMonthTable";
import { SalesTable, type SaleRow } from "@/features/conciliation/SalesTable";
import { DepositsTable } from "@/features/conciliation/DepositsTable";
import { MatchDialog } from "@/features/conciliation/MatchDialog";
import { StatementValuesTable } from "@/components/imports/StatementValuesTable";

type View = "grid" | "statement" | "sales" | "ignored";

export function ConciliationPage(): ReactElement {
  const utils = trpc.useUtils();
  const { period } = usePeriod();
  const { from, to } = periodRange(period);
  const [view, setView] = useState<View>("grid");
  const [matchTarget, setMatchTarget] = useState<SaleRow | null>(null);

  // While an upload is still parsing, poll so the flow's auto-navigation
  // lands on a page that fills itself in when the data arrives.
  const importsBusy = useImportsBusy();
  const live = { refetchInterval: importsBusy ? 2500 : (false as const) };

  const salesQuery = trpc.conciliation.listSales.useQuery({ bucket: "all", from, to }, live);
  const ignoredQuery = trpc.conciliation.listSales.useQuery(
    { bucket: "ignored", from, to },
    { enabled: view === "ignored", ...live },
  );
  const depositsQuery = trpc.conciliation.listUnmatchedDeposits.useQuery({ from, to }, live);
  const statementQuery = trpc.conciliation.listStatementRows.useQuery(
    { from, to },
    { enabled: view === "statement", ...live },
  );

  const invalidate = (): void => {
    void utils.conciliation.invalidate();
  };
  const onError = (err: { message: string }): void => {
    toast.error(err.message);
  };

  const runMutation = trpc.conciliation.runMatching.useMutation({
    onSuccess: (r) => {
      invalidate();
      toast.success(
        `${String(r.matched)} venda${r.matched === 1 ? "" : "s"} conciliada${r.matched === 1 ? "" : "s"}; ${String(r.remaining)} pendente${r.remaining === 1 ? "" : "s"}.`,
      );
    },
    onError,
  });
  const ignoreMutation = trpc.conciliation.ignoreSale.useMutation({
    onSuccess: invalidate,
    onError,
  });
  const unmatchMutation = trpc.conciliation.unmatch.useMutation({
    onSuccess: invalidate,
    onError,
  });
  const restoreMutation = trpc.conciliation.restoreSale.useMutation({
    onSuccess: invalidate,
    onError,
  });

  const sales = salesQuery.data ?? [];
  const pending = sales.filter((s) => s.deposits.length === 0);
  const pendingTotal = pending.reduce((acc, s) => acc + s.netAmount, 0n);
  const matchedCount = sales.length - pending.length;
  const depositCount = depositsQuery.data?.length ?? 0;

  return (
    <AppLayout>
      <PageHeader
        eyebrow="G-02"
        title="Conciliação"
        lede={
          <span className="flex flex-wrap items-baseline gap-x-2 tabular-nums">
            <span className="font-[550] text-[color:var(--ink)]">{pending.length}</span> pendentes
            {pending.length > 0 && <> · {formatCurrency(Number(pendingTotal) / 100)}</>}
            <span aria-hidden>|</span>
            <span className="font-[550] text-[color:var(--positive)]">{matchedCount}</span>{" "}
            conciliadas
            <span aria-hidden>|</span>
            <span className="font-[550] text-[color:var(--ink)]">{depositCount}</span> depósitos sem
            venda
          </span>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={view}
          onValueChange={(v) => {
            setView(v as View);
          }}
        >
          <TabsList>
            <TabsTrigger value="grid">Conferência</TabsTrigger>
            <TabsTrigger value="statement">Extrato</TabsTrigger>
            <TabsTrigger value="sales">Vendas</TabsTrigger>
            <TabsTrigger value="ignored">Ignoradas</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-3">
          {importsBusy && (
            <span className="flex items-center gap-1.5 text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Processando importação…
            </span>
          )}
          <Button
            size="sm"
            onClick={() => {
              runMutation.mutate({});
            }}
            disabled={runMutation.isPending}
          >
            {runMutation.isPending ? "Conciliando…" : "Conciliar automaticamente"}
          </Button>
        </div>
      </div>

      {view === "grid" && (
        <>
          {salesQuery.isLoading ? (
            <p className="py-8 text-center text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
              Carregando…
            </p>
          ) : (
            <DailyGrid
              sales={sales}
              onOpenMatch={setMatchTarget}
              onIgnore={(id) => {
                ignoreMutation.mutate({ id });
              }}
              onUnmatch={(id) => {
                unmatchMutation.mutate({ id });
              }}
            />
          )}

          {depositCount > 0 && (
            <section className="flex flex-col gap-3 pt-2">
              <Eyebrow>Depósitos sem venda · {depositCount}</Eyebrow>
              <DepositsTable rows={depositsQuery.data ?? []} />
            </section>
          )}
        </>
      )}

      {view === "statement" && (
        <>
          {statementQuery.isLoading ? (
            <p className="py-8 text-center text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
              Carregando…
            </p>
          ) : (
            <StatementValuesTable
              rows={(statementQuery.data ?? []).map((r, i) => ({
                ...r,
                lineNumber: i + 1,
              }))}
            />
          )}
        </>
      )}

      {view === "sales" && <VendasMonthTable rows={sales} />}

      {view === "ignored" && (
        <SalesTable
          bucket="ignored"
          rows={ignoredQuery.data ?? []}
          onOpenMatch={setMatchTarget}
          onIgnore={(id) => {
            ignoreMutation.mutate({ id });
          }}
          onUnmatch={(id) => {
            unmatchMutation.mutate({ id });
          }}
          onRestore={(id) => {
            restoreMutation.mutate({ id });
          }}
        />
      )}

      <MatchDialog
        sale={matchTarget}
        onClose={() => {
          setMatchTarget(null);
        }}
        onMatched={invalidate}
      />
    </AppLayout>
  );
}
