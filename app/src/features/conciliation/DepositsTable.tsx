// Acquirer-labeled deposits in the saved ledger that no sale row claims —
// the "money arrived with no matching sales" side of the issues report.

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
import { formatCurrency, formatDate } from "@/shared/lib/format";
import type { TrpcOutput } from "@/shared/lib/trpc";

type DepositRow = TrpcOutput["conciliation"]["listUnmatchedDeposits"][number];

export function DepositsTable({ rows }: { rows: DepositRow[] }): ReactElement {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(50);
  const pagination = usePagination(rows, { page, pageSize });

  if (rows.length === 0) {
    return (
      <p className="py-8 text-center text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)] italic">
        Nenhum depósito sem venda correspondente.
      </p>
    );
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Data</TableHead>
            <TableHead>Adquirente</TableHead>
            <TableHead>Descrição</TableHead>
            <TableHead className="text-right">Valor</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pagination.rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="tabular-nums">
                {row.actualDate !== null ? formatDate(row.actualDate) : "—"}
              </TableCell>
              <TableCell>{row.acquirerLabel}</TableCell>
              <TableCell className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)]">
                {row.description ?? "—"}
              </TableCell>
              <TableCell className="text-right tabular-nums font-[500]">
                {formatCurrency(Number(row.actualAmount) / 100)}
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
