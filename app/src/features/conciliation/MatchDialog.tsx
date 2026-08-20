// Manual match: pick the deposit transaction a pending sale belongs to.
// Candidates are the acquirer-labeled unmatched deposits, ranked by how
// close their value is to the sale's net.

import { useMemo, type ReactElement } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { trpc, type TrpcOutput } from "@/shared/lib/trpc";
import { formatCurrency, formatDate } from "@/shared/lib/format";

type SaleRow = TrpcOutput["conciliation"]["listSales"][number];

function cents(value: bigint): string {
  return formatCurrency(Number(value) / 100);
}

export function MatchDialog({
  sale,
  onClose,
  onMatched,
}: {
  sale: SaleRow | null;
  onClose: () => void;
  onMatched: () => void;
}): ReactElement {
  const depositsQuery = trpc.conciliation.listUnmatchedDeposits.useQuery(
    {},
    { enabled: sale !== null },
  );

  const matchMutation = trpc.conciliation.matchManually.useMutation({
    onSuccess: () => {
      onMatched();
      onClose();
    },
  });

  const ranked = useMemo(() => {
    if (sale === null || depositsQuery.data === undefined) return [];
    const target = sale.netAmount;
    return [...depositsQuery.data]
      .sort((a, b) => {
        const da = a.actualAmount > target ? a.actualAmount - target : target - a.actualAmount;
        const db = b.actualAmount > target ? b.actualAmount - target : target - b.actualAmount;
        return da < db ? -1 : da > db ? 1 : 0;
      })
      .slice(0, 20);
  }, [sale, depositsQuery.data]);

  return (
    <Dialog
      open={sale !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Conciliar venda</DialogTitle>
          <DialogDescription>
            {sale !== null && (
              <>
                {formatDate(sale.saleDate)} · {sale.method} ·{" "}
                <span className="tabular-nums">{cents(sale.netAmount)}</span> — escolha o depósito
                correspondente no extrato.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {depositsQuery.isLoading && (
          <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
            Carregando depósitos…
          </p>
        )}
        {ranked.length === 0 && !depositsQuery.isLoading && (
          <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)] italic">
            Nenhum depósito disponível — importe e salve o extrato que contém o repasse.
          </p>
        )}

        <ul className="flex flex-col divide-y divide-[color:var(--rule)] max-h-80 overflow-y-auto">
          {ranked.map((d) => (
            <li key={d.id} className="flex items-center gap-3 py-2">
              <span className="tabular-nums text-[color:var(--ink)] w-28 shrink-0">
                {cents(d.actualAmount)}
              </span>
              <span className="tabular-nums text-[color:var(--ink-soft)] w-24 shrink-0">
                {formatDate(d.actualDate)}
              </span>
              <span className="text-[color:var(--ink-soft)] text-[length:var(--fs-body-sm)] truncate flex-1">
                {d.description ?? "—"}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={matchMutation.isPending || sale === null}
                onClick={() => {
                  if (sale !== null) {
                    matchMutation.mutate({ saleIds: [sale.id], depositRowId: d.id });
                  }
                }}
              >
                Vincular
              </Button>
            </li>
          ))}
        </ul>
        {matchMutation.error !== null && (
          <p className="text-[length:var(--fs-body-sm)] text-[color:var(--negative)]">
            {matchMutation.error.message}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
