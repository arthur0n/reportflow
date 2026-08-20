// The Conferência view: one row per sale day of the selected month — sales
// net, the deposit(s) that settled it, and the day's status. A day expands
// into its method rows with the workable actions.

import { useState, type ReactElement } from "react";
import { ChevronRight } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDate } from "@/shared/lib/format";
import type { SaleRow } from "./SalesTable";

function cents(value: bigint): string {
  return formatCurrency(Number(value) / 100);
}

type DayStatus = "matched" | "partial" | "pending";

type DayGroup = {
  saleDate: string;
  rows: SaleRow[];
  netTotal: bigint;
  receivedTotal: bigint; // sale-side sum of the day's matched rows
  depositCount: number;
  status: DayStatus;
};

const DAY_BADGE: Record<DayStatus, { variant: "success" | "warning" | "outline"; label: string }> =
  {
    matched: { variant: "success", label: "Conciliado" },
    partial: { variant: "warning", label: "Parcial" },
    pending: { variant: "outline", label: "Pendente" },
  };

function groupByDay(sales: SaleRow[]): DayGroup[] {
  const byDate = new Map<string, SaleRow[]>();
  for (const sale of sales) {
    const list = byDate.get(sale.saleDate) ?? [];
    list.push(sale);
    byDate.set(sale.saleDate, list);
  }
  return [...byDate.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([saleDate, rows]) => {
      const matched = rows.filter((r) => r.deposits.length > 0);
      const depositIds = new Set<string>();
      for (const r of matched) {
        for (const d of r.deposits) depositIds.add(d.rowId);
      }
      return {
        saleDate,
        rows,
        netTotal: rows.reduce((acc, r) => acc + r.netAmount, 0n),
        receivedTotal: matched.reduce((acc, r) => acc + r.netAmount, 0n),
        depositCount: depositIds.size,
        status:
          matched.length === rows.length
            ? ("matched" as const)
            : matched.length > 0
              ? ("partial" as const)
              : ("pending" as const),
      };
    });
}

// The linked bank lines, printed exactly as the extrato shows them — every
// value here is findable in the bank app.
function DepositLines({ deposits }: { deposits: SaleRow["deposits"] }): ReactElement | null {
  if (deposits.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 pl-6 pb-1.5">
      {deposits.map((d) => (
        <li
          key={d.rowId}
          className="flex items-baseline gap-2.5 text-[length:var(--fs-eyebrow)] text-[color:var(--ink-mute)]"
        >
          <span className="tabular-nums shrink-0">{d.date !== null ? formatDate(d.date) : ""}</span>
          <span className="tabular-nums shrink-0 w-20 text-right text-[color:var(--ink-soft)]">
            {cents(d.amount)}
          </span>
          <span className="truncate">{d.description ?? ""}</span>
        </li>
      ))}
    </ul>
  );
}

function DayDetail({
  rows,
  onOpenMatch,
  onIgnore,
  onUnmatch,
}: {
  rows: SaleRow[];
  onOpenMatch: (row: SaleRow) => void;
  onIgnore: (id: string) => void;
  onUnmatch: (id: string) => void;
}): ReactElement {
  return (
    <div className="flex flex-col divide-y divide-[color:var(--rule)] pl-9 pr-2 py-1 bg-[color:var(--paper-sink)]/40">
      {rows.map((row) => (
        <div key={row.id} className="flex flex-col">
          <div className="flex items-center gap-3 py-1.5 text-[length:var(--fs-body-sm)]">
            <span className="flex-1">{row.method}</span>
            <span className="tabular-nums text-[color:var(--ink-mute)]">
              {cents(row.grossAmount)}
            </span>
            <span className="tabular-nums text-[color:var(--ink-mute)]">
              {cents(row.feeAmount)}
            </span>
            <span className="tabular-nums font-[500] w-24 text-right">{cents(row.netAmount)}</span>
            {row.deposits.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  onUnmatch(row.id);
                }}
              >
                Desfazer
              </Button>
            ) : (
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
          </div>
          <DepositLines deposits={row.deposits} />
        </div>
      ))}
    </div>
  );
}

// Plain-language settlement summary: what already hit the bank vs what the
// acquirer still owes for the day.
function ReceivedLabel({ day }: { day: DayGroup }): ReactElement {
  if (day.status === "matched") {
    return (
      <span className="text-[color:var(--positive)]">
        Recebido {cents(day.receivedTotal)}
        <span className="text-[color:var(--ink-mute)]">
          {" "}
          · {day.depositCount} depósito{day.depositCount === 1 ? "" : "s"}
        </span>
      </span>
    );
  }
  if (day.status === "pending") {
    return <span className="text-[color:var(--ink-mute)] italic">Nenhum depósito recebido</span>;
  }
  return (
    <span className="text-[color:var(--ink-soft)]">
      Recebido <span className="tabular-nums">{cents(day.receivedTotal)}</span> de{" "}
      <span className="tabular-nums">{cents(day.netTotal)}</span>
      <span className="text-[color:var(--caution)] font-[550]">
        {" "}
        · falta {cents(day.netTotal - day.receivedTotal)}
      </span>
    </span>
  );
}

export function DailyGrid({
  sales,
  onOpenMatch,
  onIgnore,
  onUnmatch,
}: {
  sales: SaleRow[];
  onOpenMatch: (row: SaleRow) => void;
  onIgnore: (id: string) => void;
  onUnmatch: (id: string) => void;
}): ReactElement {
  const [openDay, setOpenDay] = useState<string | null>(null);
  const days = groupByDay(sales);

  if (days.length === 0) {
    return (
      <p className="py-8 text-center text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)] italic">
        Nenhuma venda de adquirente neste mês.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-8"></TableHead>
          <TableHead>Dia</TableHead>
          <TableHead className="text-right">Vendas (líquido)</TableHead>
          <TableHead>Recebido no banco</TableHead>
          <TableHead>Status</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {days.map((day) => {
          const badge = DAY_BADGE[day.status];
          const open = openDay === day.saleDate;
          return [
            <TableRow
              key={day.saleDate}
              className="cursor-pointer"
              onClick={() => {
                setOpenDay(open ? null : day.saleDate);
              }}
            >
              <TableCell>
                <ChevronRight
                  className={cn(
                    "h-3.5 w-3.5 text-[color:var(--ink-mute)] transition-transform",
                    open && "rotate-90",
                  )}
                />
              </TableCell>
              <TableCell className="tabular-nums">{formatDate(day.saleDate)}</TableCell>
              <TableCell className="text-right tabular-nums font-[500]">
                {cents(day.netTotal)}
              </TableCell>
              <TableCell className="text-[length:var(--fs-body-sm)]">
                <ReceivedLabel day={day} />
              </TableCell>
              <TableCell>
                <Badge variant={badge.variant}>{badge.label}</Badge>
              </TableCell>
            </TableRow>,
            open ? (
              <TableRow key={`${day.saleDate}-detail`}>
                <TableCell colSpan={5} className="p-0">
                  <DayDetail
                    rows={day.rows}
                    onOpenMatch={onOpenMatch}
                    onIgnore={onIgnore}
                    onUnmatch={onUnmatch}
                  />
                </TableCell>
              </TableRow>
            ) : null,
          ];
        })}
      </TableBody>
    </Table>
  );
}
