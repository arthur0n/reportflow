import type { ReactElement } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Column, ColumnKey, TxRow } from "@/components/transactions/columns";

// Excel-like ledger table:
// - Sticky-left checkbox column (UI shell only — no selection state yet).
// - Sticky-right per-row action column.
// - Sticky-top header row; the corner cells get higher z so they sit above
//   the body's sticky-side cells where the axes intersect.
// - The Table wrapper is the scroll context (containerClassName below).
type Props = {
  rows: readonly TxRow[];
  visibleColumns: readonly Column[];
  sortKey: ColumnKey | null;
  sortDir: "asc" | "desc";
  onToggleSort: (key: ColumnKey) => void;
  onRecurrenceClick: (row: TxRow) => void;
};

const STICKY_CORNER = "sticky top-0 z-30 bg-muted";
const STICKY_HEADER = "sticky top-0 z-20 bg-muted";
const STICKY_LEFT_CELL = "sticky left-0 z-10 bg-muted";
const STICKY_RIGHT_CELL = "sticky right-0 z-10 bg-muted";

export function TransactionsLedgerTable({
  rows,
  visibleColumns,
  sortKey,
  sortDir,
  onToggleSort,
  onRecurrenceClick,
}: Props): ReactElement {
  return (
    <Table
      containerClassName="max-h-[calc(100vh-260px)] overflow-auto"
      className="[&_td]:py-1.5 [&_th]:h-8 [&_th]:px-2 [&_td]:px-2"
    >
      <TableHeader>
        <TableRow>
          <TableHead
            className={`${STICKY_CORNER} left-0 w-14 px-3 border-r border-[color:var(--rule)] text-center`}
            aria-label="Selecionar todos"
          >
            <Checkbox aria-label="Selecionar todos" disabled />
          </TableHead>
          {visibleColumns.map((c) => {
            const sorted = sortKey === c.key;
            const Icon = sorted ? (sortDir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
            return (
              <TableHead
                key={c.key}
                className={`${STICKY_HEADER} ${c.align === "right" ? "text-right" : ""}`}
              >
                <button
                  type="button"
                  onClick={() => {
                    onToggleSort(c.key);
                  }}
                  className={`inline-flex items-center gap-1 hover:text-[color:var(--ink)] ${c.align === "right" ? "flex-row-reverse" : ""}`}
                >
                  <span>{c.label}</span>
                  <Icon
                    className={`h-3 w-3 ${sorted ? "text-[color:var(--ink)]" : "text-[color:var(--ink-mute)]"}`}
                  />
                </button>
              </TableHead>
            );
          })}
          <TableHead
            className={`${STICKY_CORNER} right-0 w-12 border-l border-[color:var(--rule)] text-center`}
          >
            Ações
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((t) => (
          <TableRow key={t.id}>
            <TableCell
              className={`${STICKY_LEFT_CELL} w-14 px-3 border-r border-[color:var(--rule)] text-center`}
            >
              <Checkbox aria-label="Selecionar linha" disabled />
            </TableCell>
            {visibleColumns.map((c) => (
              <TableCell
                key={c.key}
                className={`${c.align === "right" ? "text-right" : ""} ${c.key === "description" ? "max-w-md" : ""}`}
              >
                {c.render(t)}
              </TableCell>
            ))}
            <TableCell
              className={`${STICKY_RIGHT_CELL} w-12 border-l border-[color:var(--rule)] text-center`}
            >
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label="Recorrência"
                title="Recorrência"
                onClick={() => {
                  onRecurrenceClick(t);
                }}
              >
                <Repeat className="h-4 w-4" />
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
