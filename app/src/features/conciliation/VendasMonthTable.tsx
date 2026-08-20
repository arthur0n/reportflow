// Vendas view: the month's acquirer sales as a plain values table with a
// status chip. Actions live in the Conferência grid — this view is for
// reading the numbers.

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
import { Badge } from "@/components/ui/badge";
import { Metric } from "@/components/ui/metric";
import { formatCurrency, formatDate } from "@/shared/lib/format";
import type { SaleRow } from "./SalesTable";

function cents(value: bigint): string {
  return formatCurrency(Number(value) / 100);
}

export function VendasMonthTable({ rows }: { rows: SaleRow[] }): ReactElement {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(50);
  const pagination = usePagination(rows, { page, pageSize });

  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)] italic">
        Nenhuma venda neste mês.
      </p>
    );
  }

  const gross = rows.reduce((acc, r) => acc + r.grossAmount, 0n);
  const fees = rows.reduce((acc, r) => acc + r.feeAmount, 0n);
  const net = rows.reduce((acc, r) => acc + r.netAmount, 0n);

  return (
    <section className="flex flex-col gap-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Metric label="Linhas" value={String(rows.length)} size="compact" />
        <Metric label="Bruto" value={cents(gross)} size="compact" />
        <Metric label="Taxas" value={cents(fees < 0n ? -fees : fees)} size="compact" />
        <Metric label="Líquido" value={cents(net)} size="compact" />
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Data</TableHead>
            <TableHead>Hora</TableHead>
            <TableHead>Forma</TableHead>
            <TableHead>Bandeira</TableHead>
            <TableHead className="text-right">Bruto</TableHead>
            <TableHead className="text-right">Taxa</TableHead>
            <TableHead className="text-right">Líquido</TableHead>
            <TableHead>Prevista</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pagination.rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="tabular-nums">{formatDate(row.saleDate)}</TableCell>
              <TableCell className="tabular-nums text-[color:var(--ink-mute)]">
                {row.saleTime ?? ""}
              </TableCell>
              <TableCell>{row.method}</TableCell>
              <TableCell className="text-[color:var(--ink-soft)]">{row.brand ?? ""}</TableCell>
              <TableCell className="text-right tabular-nums">{cents(row.grossAmount)}</TableCell>
              <TableCell className="text-right tabular-nums text-[color:var(--ink-mute)]">
                {cents(row.feeAmount)}
              </TableCell>
              <TableCell className="text-right tabular-nums font-[500]">
                {cents(row.netAmount)}
              </TableCell>
              <TableCell className="tabular-nums text-[color:var(--ink-soft)]">
                {formatDate(row.expectedPaymentDate)}
              </TableCell>
              <TableCell>
                {row.deposits.length > 0 ? (
                  <Badge variant="success">Conciliada</Badge>
                ) : (
                  <Badge variant="outline">Pendente</Badge>
                )}
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
    </section>
  );
}
