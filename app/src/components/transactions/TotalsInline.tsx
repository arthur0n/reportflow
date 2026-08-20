import { type ReactElement } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/shared/lib/format";

function Stat({
  label,
  value,
  hidden,
  valueClass = "",
  onToggle,
}: {
  label: string;
  value: string;
  hidden: boolean;
  valueClass?: string;
  onToggle: () => void;
}): ReactElement {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-[length:var(--fs-eyebrow)] uppercase tracking-wide text-[color:var(--ink-mute)]">
        {label}
      </span>
      <button
        type="button"
        onClick={onToggle}
        className={`font-medium tabular-nums transition-[filter] ${valueClass} ${
          hidden ? "blur-[5px] select-none" : ""
        }`}
        aria-label={hidden ? `Mostrar ${label.toLowerCase()}` : `Ocultar ${label.toLowerCase()}`}
      >
        {value}
      </button>
    </span>
  );
}

export function TotalsInline({
  income,
  outflow,
  balance,
  hidden,
  onToggle,
}: {
  income: number;
  outflow: number;
  balance: number;
  hidden: boolean;
  onToggle: () => void;
}): ReactElement {
  return (
    <div className="flex items-center gap-3 text-[length:var(--fs-body-sm)]">
      <Stat label="Entradas" value={formatCurrency(income)} hidden={hidden} onToggle={onToggle} />
      <Stat label="Saídas" value={formatCurrency(outflow)} hidden={hidden} onToggle={onToggle} />
      <Stat
        label="Saldo"
        value={formatCurrency(balance)}
        hidden={hidden}
        valueClass={balance >= 0 ? "text-[color:var(--positive)]" : "text-[color:var(--negative)]"}
        onToggle={onToggle}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onToggle}
        className="h-7 w-7 shrink-0"
        aria-label={hidden ? "Mostrar valores" : "Ocultar valores"}
      >
        {hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </Button>
    </div>
  );
}
