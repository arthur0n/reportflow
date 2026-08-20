// Read-only view of an import's parsed values — the user sees what arrived
// before (and regardless of) any review/classification. Totals up top,
// client-side pagination for large statements.

import { useState, type ReactElement } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { TablePagination } from "@/components/ui/table-pagination";
import { Metric } from "@/components/ui/metric";
import { usePagination, type PageSize } from "@/hooks/use-pagination";
import { formatCurrency, formatDate } from "@/shared/lib/format";

export type StatementValueRow = {
  id: string;
  lineNumber: number;
  actualDate: string | null;
  description: string | null;
  actualAmount: bigint | null;
};

function cents(value: bigint): string {
  return formatCurrency(Number(value) / 100);
}

export function StatementValuesTable({ rows }: { rows: StatementValueRow[] }): ReactElement {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(50);

  const credits = rows.reduce(
    (acc, r) => (r.actualAmount !== null && r.actualAmount > 0n ? acc + r.actualAmount : acc),
    0n,
  );
  const debits = rows.reduce(
    (acc, r) => (r.actualAmount !== null && r.actualAmount < 0n ? acc + r.actualAmount : acc),
    0n,
  );

  const pagination = usePagination(rows, { page, pageSize });

  return (
    <section className="flex flex-col gap-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Metric label="Linhas" value={String(rows.length)} size="compact" />
        <Metric label="Entradas" value={cents(credits)} size="compact" />
        <Metric label="Saídas" value={cents(debits < 0n ? -debits : debits)} size="compact" />
        <Metric label="Saldo do período" value={cents(credits + debits)} size="compact" />
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>#</TableHead>
            <TableHead>Data</TableHead>
            <TableHead>Descrição</TableHead>
            <TableHead className="text-right">Valor</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pagination.rows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="tabular-nums text-[length:var(--fs-eyebrow)] text-[color:var(--ink-mute)]">
                {String(row.lineNumber).padStart(3, "0")}
              </TableCell>
              <TableCell className="tabular-nums">
                {row.actualDate !== null ? formatDate(row.actualDate) : "—"}
              </TableCell>
              <TableCell className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)]">
                {row.description ?? "—"}
              </TableCell>
              <TableCell
                className={`text-right tabular-nums font-[500] ${
                  row.actualAmount !== null && row.actualAmount < 0n
                    ? "text-[color:var(--negative)]"
                    : "text-[color:var(--positive)]"
                }`}
              >
                {row.actualAmount !== null ? cents(row.actualAmount) : "—"}
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
