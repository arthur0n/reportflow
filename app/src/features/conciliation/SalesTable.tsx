// Sales rows for one bucket of the issues report. Pending rows carry the
// workable actions (conciliar manualmente / ignorar); matched rows show the
// linked deposit and can be undone; ignored rows can be restored.

import { useState, type ReactElement } from "react";
import { TablePagination } from "@/components/ui/table-pagination";
import { usePagination, type PageSize } from "@/hooks/use-pagination";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate } from "@/shared/lib/format";
import type { TrpcOutput } from "@/shared/lib/trpc";

export type SaleRow = TrpcOutput["conciliation"]["listSales"][number];
export type SaleBucket = "pending" | "matched" | "ignored";

function cents(value: bigint): string {
  return formatCurrency(Number(value) / 100);
}

// Days PAST the acquirer's declared settlement date — 0 while not yet due.
// "Today" is the viewer's local calendar date; both sides then compare as
// date-only values so stored dates never shift.
function overdueDays(expectedPaymentDate: string): number {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  const today = Date.parse(
    `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
  );
  return Math.max(0, Math.round((today - Date.parse(expectedPaymentDate)) / 86_400_000));
}

export function SalesTable({
  bucket,
  rows,
  onOpenMatch,
  onIgnore,
  onUnmatch,
  onRestore,
}: {
  bucket: SaleBucket;
  rows: SaleRow[];
  onOpenMatch: (row: SaleRow) => void;
  onIgnore: (id: string) => void;
  onUnmatch: (id: string) => void;
  onRestore: (id: string) => void;
}): ReactElement {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(50);
  const pagination = usePagination(rows, { page, pageSize });

  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)] italic">
        Nenhuma venda nesta lista.
      </p>
    );
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Data da venda</TableHead>
            <TableHead>Forma de pagamento</TableHead>
            <TableHead className="text-right">Bruto</TableHead>
            <TableHead className="text-right">Taxa</TableHead>
            <TableHead className="text-right">Líquido</TableHead>
            {bucket === "pending" && <TableHead className="text-right">Dias em atraso</TableHead>}
            {bucket === "matched" && <TableHead>Depósito</TableHead>}
            <TableHead></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pagination.rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="tabular-nums">{formatDate(row.saleDate)}</TableCell>
              <TableCell>{row.method}</TableCell>
              <TableCell className="text-right tabular-nums">{cents(row.grossAmount)}</TableCell>
              <TableCell className="text-right tabular-nums text-[color:var(--ink-mute)]">
                {cents(row.feeAmount)}
              </TableCell>
              <TableCell className="text-right tabular-nums font-[500]">
                {cents(row.netAmount)}
              </TableCell>
              {bucket === "pending" && (
                <TableCell className="text-right tabular-nums text-[color:var(--ink-mute)]">
                  {overdueDays(row.expectedPaymentDate)}
                </TableCell>
              )}
              {bucket === "matched" && (
                <TableCell className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)]">
                  {row.deposits.length === 1 ? (
                    <>
                      {row.deposits[0]?.date != null && (
                        <span className="tabular-nums">{formatDate(row.deposits[0].date)} · </span>
                      )}
                      <span className="tabular-nums">
                        {cents(row.deposits[0]?.amount ?? 0n)} ·{" "}
                      </span>
                      <span className="truncate">{row.deposits[0]?.description ?? ""}</span>
                    </>
                  ) : (
                    <span className="tabular-nums">
                      {row.deposits.length} depósitos ·{" "}
                      {cents(row.deposits.reduce((acc, d) => acc + d.amount, 0n))}
                    </span>
                  )}
                </TableCell>
              )}
              <TableCell>
                <div className="flex justify-end gap-1.5">
                  {bucket === "pending" && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          onOpenMatch(row);
                        }}
                      >
                        Conciliar…
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          onIgnore(row.id);
                        }}
                      >
                        Ignorar
                      </Button>
                    </>
                  )}
                  {bucket === "matched" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        onUnmatch(row.id);
                      }}
                    >
                      Desfazer
                    </Button>
                  )}
                  {bucket === "ignored" && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        onRestore(row.id);
                      }}
                    >
                      Restaurar
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <TablePagination
        page={pagination.page}
        pageSize={pageSize}
        totalRows={pagination.totalRows}
        startIndex={pagination.startIndex}
        endIndex={pagination.endIndex}
        totalPages={pagination.totalPages}
        onPageChange={setPage}
        onPageSizeChange={(size) => {
          setPageSize(size);
          setPage(1);
        }}
      />
    </>
  );
}
