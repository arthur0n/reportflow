import type { ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { Metric } from "@/components/ui/metric";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Rule } from "@/components/ui/rule";

type SummaryCounts = {
  new: number;
  matched: number;
  skipped: number;
  deleted: number;
};

export function ImportSummary({
  counts,
  isApproving,
  isRejecting,
  approveError,
  onApprove,
  onReject,
}: {
  counts: SummaryCounts;
  isApproving: boolean;
  isRejecting: boolean;
  approveError: string | null;
  onApprove: () => void;
  onReject: () => void;
}): ReactElement {
  const total = counts.new + counts.matched + counts.skipped + counts.deleted;

  return (
    <section className="mt-6 flex flex-col gap-5">
      <div className="flex items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Eyebrow>Resumo da revisão</Eyebrow>
          <h3 className="font-serif text-[length:var(--fs-section)] font-[500] tracking-[-0.012em] text-[color:var(--ink)]">
            Pronto para aprovar
          </h3>
        </div>
      </div>

      <Rule strong />

      <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
        <Metric label="Novas" value={counts.new} size="compact" />
        <Metric label="Conciliadas" value={counts.matched} size="compact" />
        <Metric label="Puladas" value={counts.skipped} size="compact" />
        <Metric label="Excluídas" value={counts.deleted} size="compact" />
      </div>

      <Rule />

      <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)] max-w-prose">
        {total === 0
          ? "Nenhuma linha para processar."
          : `Ao aprovar, ${String(counts.new)} transação(ões) serão criadas e ${String(counts.matched)} serão conciliadas.`}
      </p>

      {approveError !== null && (
        <div className="border-l-2 border-[color:var(--negative)] pl-3 py-1">
          <Eyebrow tone="negative">Falha ao aprovar</Eyebrow>
          <p className="text-[length:var(--fs-body-sm)] text-[color:var(--negative)] mt-1">
            {approveError}
          </p>
        </div>
      )}

      <div className="flex gap-3 pt-2">
        <Button variant="accent" onClick={onApprove} disabled={isApproving || total === 0}>
          {isApproving ? "Aprovando…" : "Aprovar importação"}
        </Button>
        <Button variant="ghost" onClick={onReject} disabled={isRejecting}>
          {isRejecting ? "Rejeitando…" : "Rejeitar"}
        </Button>
      </div>
    </section>
  );
}
