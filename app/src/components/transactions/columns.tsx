import type { ReactElement } from "react";
import { Badge } from "@/components/ui/badge";
import type { TrpcOutput } from "@/shared/lib/trpc";
import { formatDate, formatCurrency } from "@/shared/lib/format";

export type TxRow = TrpcOutput["transactions"]["list"][number];

export type Align = "left" | "right";

export type ColumnKey =
  | "statusCode"
  | "transactionTypeLabel"
  | "subtypeLabel"
  | "businessUnitLabel"
  | "creditorLabel"
  | "categoryLabel"
  | "paymentMethodLabel"
  | "cashBoxLabel"
  | "accrualDate"
  | "dueDate"
  | "actualDate"
  | "forecastAmount"
  | "actualAmount"
  | "interestAmount"
  | "description"
  | "reference"
  | "externalId"
  | "createdAt"
  | "lastUpdAt";

export type Column = {
  key: ColumnKey;
  label: string;
  align: Align;
  defaultVisible: boolean;
  /** Returns a comparable primitive for client-side sorting; null sorts last. */
  sortValue: (row: TxRow) => string | number | null;
  render: (row: TxRow) => ReactElement | string | null;
};

function centsToNumber(cents: bigint | number | null | undefined): number | null {
  if (cents === null || cents === undefined) return null;
  return Number(cents) / 100;
}

export function centsToBRL(cents: bigint | number | null | undefined): string {
  const n = centsToNumber(cents);
  return n === null ? "" : formatCurrency(n);
}

export function signedClass(value: number | null): string {
  if (value === null) return "text-[color:var(--ink-mute)]";
  if (value > 0) return "text-[color:var(--positive)]";
  if (value < 0) return "text-[color:var(--negative)]";
  return "text-[color:var(--ink)]";
}

const STATUS_VARIANT: Record<
  string,
  "success" | "warning" | "accent" | "destructive" | "outline" | "secondary"
> = {
  CERTO: "success",
  ESTIMADO: "warning",
  META: "accent",
  REVISAR: "warning",
  FANEC: "outline",
};

export const COLUMNS: readonly Column[] = [
  {
    key: "accrualDate",
    label: "Competência",
    align: "left",
    defaultVisible: true,
    sortValue: (r) => r.accrualDate,
    render: (r) => (
      <span className="tabular-nums text-[color:var(--ink-soft)]">{formatDate(r.accrualDate)}</span>
    ),
  },
  {
    key: "dueDate",
    label: "Vencimento",
    align: "left",
    defaultVisible: true,
    sortValue: (r) => r.dueDate,
    render: (r) => (
      <span className="tabular-nums text-[color:var(--ink-soft)]">{formatDate(r.dueDate)}</span>
    ),
  },
  {
    key: "actualDate",
    label: "Data real",
    align: "left",
    defaultVisible: false,
    sortValue: (r) => r.actualDate,
    render: (r) => (
      <span className="tabular-nums text-[color:var(--ink-soft)]">
        {r.actualDate !== null ? formatDate(r.actualDate) : "—"}
      </span>
    ),
  },
  {
    key: "description",
    label: "Descrição",
    align: "left",
    defaultVisible: true,
    sortValue: (r) => r.description?.toLowerCase() ?? null,
    render: (r) => (
      <span className="font-[450] text-[color:var(--ink)] break-words">{r.description ?? "—"}</span>
    ),
  },
  {
    key: "reference",
    label: "Referência",
    align: "left",
    defaultVisible: false,
    sortValue: (r) => r.reference?.toLowerCase() ?? null,
    render: (r) => <span className="text-[color:var(--ink-soft)]">{r.reference ?? "—"}</span>,
  },
  {
    key: "transactionTypeLabel",
    label: "Tipo",
    align: "left",
    defaultVisible: false,
    sortValue: (r) => r.transactionTypeLabel?.toLowerCase() ?? null,
    render: (r) => (
      <span className="text-[color:var(--ink-soft)]">{r.transactionTypeLabel ?? "—"}</span>
    ),
  },
  {
    key: "subtypeLabel",
    label: "Subtipo",
    align: "left",
    defaultVisible: false,
    sortValue: (r) => r.subtypeLabel?.toLowerCase() ?? null,
    render: (r) => <span className="text-[color:var(--ink-soft)]">{r.subtypeLabel ?? "—"}</span>,
  },
  {
    key: "businessUnitLabel",
    label: "Unidade",
    align: "left",
    defaultVisible: false,
    sortValue: (r) => r.businessUnitLabel?.toLowerCase() ?? null,
    render: (r) => (
      <span className="text-[color:var(--ink-soft)]">{r.businessUnitLabel ?? "—"}</span>
    ),
  },
  {
    key: "creditorLabel",
    label: "Credor",
    align: "left",
    defaultVisible: false,
    sortValue: (r) => r.creditorLabel?.toLowerCase() ?? null,
    render: (r) => <span className="text-[color:var(--ink-soft)]">{r.creditorLabel ?? "—"}</span>,
  },
  {
    key: "categoryLabel",
    label: "Categoria",
    align: "left",
    defaultVisible: false,
    sortValue: (r) => r.categoryLabel?.toLowerCase() ?? null,
    render: (r) => <span className="text-[color:var(--ink-soft)]">{r.categoryLabel ?? "—"}</span>,
  },
  {
    key: "paymentMethodLabel",
    label: "Forma de pagamento",
    align: "left",
    defaultVisible: false,
    sortValue: (r) => r.paymentMethodLabel?.toLowerCase() ?? null,
    render: (r) => (
      <span className="text-[color:var(--ink-soft)]">{r.paymentMethodLabel ?? "—"}</span>
    ),
  },
  {
    key: "cashBoxLabel",
    label: "Caixa",
    align: "left",
    defaultVisible: false,
    sortValue: (r) => r.cashBoxLabel?.toLowerCase() ?? null,
    render: (r) => <span className="text-[color:var(--ink-soft)]">{r.cashBoxLabel ?? "—"}</span>,
  },
  {
    key: "statusCode",
    label: "Status",
    align: "left",
    defaultVisible: true,
    sortValue: (r) => r.statusCode ?? null,
    render: (r) => (
      <Badge variant={STATUS_VARIANT[r.statusCode ?? ""] ?? "outline"}>
        {r.statusLabel ?? r.statusCode ?? "—"}
      </Badge>
    ),
  },
  {
    key: "forecastAmount",
    label: "Previsto",
    align: "right",
    defaultVisible: true,
    sortValue: (r) => Number(r.forecastAmount),
    render: (r) => (
      <span className="tabular-nums text-[color:var(--ink-soft)]">
        {centsToBRL(r.forecastAmount)}
      </span>
    ),
  },
  {
    key: "actualAmount",
    label: "Real",
    align: "right",
    defaultVisible: true,
    sortValue: (r) => (r.actualAmount === null ? null : Number(r.actualAmount)),
    render: (r: TxRow): ReactElement => {
      const real = centsToNumber(r.actualAmount);
      return (
        <span className={`tabular-nums font-[500] ${signedClass(real)}`}>
          {centsToBRL(r.actualAmount)}
        </span>
      );
    },
  },
  {
    key: "interestAmount",
    label: "Juros",
    align: "right",
    defaultVisible: false,
    sortValue: (r) => Number(r.interestAmount),
    render: (r) => (
      <span className="tabular-nums text-[color:var(--ink-soft)]">
        {centsToBRL(r.interestAmount)}
      </span>
    ),
  },
  {
    key: "externalId",
    label: "ID externo",
    align: "left",
    defaultVisible: false,
    sortValue: (r) => r.externalId ?? null,
    render: (r) => (
      <span className="tabular-nums text-[color:var(--ink-mute)]">{r.externalId ?? "—"}</span>
    ),
  },
  {
    key: "createdAt",
    label: "Criado",
    align: "left",
    defaultVisible: false,
    sortValue: (r) => r.createdAt,
    render: (r) => (
      <span className="tabular-nums text-[color:var(--ink-mute)]">{formatDate(r.createdAt)}</span>
    ),
  },
  {
    key: "lastUpdAt",
    label: "Atualizado",
    align: "left",
    defaultVisible: false,
    sortValue: (r) => r.lastUpdAt,
    render: (r) => (
      <span className="tabular-nums text-[color:var(--ink-mute)]">{formatDate(r.lastUpdAt)}</span>
    ),
  },
];

export function totalsFrom(rows: readonly TxRow[]): {
  income: number;
  outflow: number;
  balance: number;
} {
  let income = 0;
  let outflow = 0;
  for (const r of rows) {
    const v = centsToNumber(r.actualAmount) ?? centsToNumber(r.forecastAmount) ?? 0;
    if (v > 0) income += v;
    else outflow += Math.abs(v);
  }
  return { income, outflow, balance: income - outflow };
}
