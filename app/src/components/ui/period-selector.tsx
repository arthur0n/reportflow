import { useMemo, useState, type ReactElement } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

const MONTHS_PT = [
  "Janeiro",
  "Fevereiro",
  "Março",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro",
] as const;

// month is 1-indexed (1 = Janeiro), matching tenants.fiscal_year_start and
// the global period context.
type PeriodSelectorProps = {
  value?: { month: number; year: number };
  onChange?: (period: { month: number; year: number }) => void;
  className?: string;
  size?: "default" | "compact";
};

export function PeriodSelector({
  value,
  onChange,
  className,
  size = "default",
}: PeriodSelectorProps): ReactElement {
  const now = useMemo(() => new Date(), []);
  const fallback = useMemo(() => ({ month: now.getMonth() + 1, year: now.getFullYear() }), [now]);
  const [internal, setInternal] = useState(fallback);

  const period = value ?? internal;

  const shift = (delta: number): void => {
    const total = period.year * 12 + (period.month - 1) + delta;
    const nextYear = Math.floor(total / 12);
    const nextMonth = total - nextYear * 12 + 1;
    const next = { month: nextMonth, year: nextYear };
    if (value === undefined) setInternal(next);
    onChange?.(next);
  };

  const labelSize =
    size === "compact"
      ? "text-[length:var(--fs-body-sm)]"
      : "text-[length:var(--fs-body)]";

  return (
    <div
      className={cn(
        "inline-flex items-center gap-2",
        "text-[color:var(--ink)]",
        className,
      )}
    >
      <button
        type="button"
        aria-label="Mês anterior"
        onClick={() => {
          shift(-1);
        }}
        className={cn(
          "inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)]",
          "text-[color:var(--ink-mute)] hover:text-[color:var(--accent)]",
          "hover:bg-[color:var(--paper-sink)] transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]",
        )}
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <div className={cn("flex items-baseline gap-1.5", labelSize)}>
        <span className="font-serif font-[500] tracking-[-0.008em]">
          {MONTHS_PT[period.month - 1]}
        </span>
        <span className="text-[color:var(--ink-mute)]">·</span>
        <span className="tabular-nums font-[450] text-[color:var(--ink-mute)]">
          {period.year}
        </span>
      </div>
      <button
        type="button"
        aria-label="Próximo mês"
        onClick={() => {
          shift(1);
        }}
        className={cn(
          "inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)]",
          "text-[color:var(--ink-mute)] hover:text-[color:var(--accent)]",
          "hover:bg-[color:var(--paper-sink)] transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]",
        )}
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}
