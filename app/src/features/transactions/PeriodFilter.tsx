import { type ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { formatMonthLabel, type PeriodFilter } from "./period-filter-utils";

export function PeriodFilterBar({
  filter,
  onChange,
}: {
  filter: PeriodFilter;
  onChange: (nextFilter: PeriodFilter) => void;
}): ReactElement {
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-3 bg-[color:var(--paper-sink)] rounded-md">
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            const newDate = new Date(filter.anchor);
            newDate.setMonth(newDate.getMonth() - 1);
            onChange({ ...filter, anchor: newDate });
          }}
          className="h-7 w-7 p-0"
        >
          ‹
        </Button>
        <span className="text-[length:var(--fs-body-sm)] font-medium px-2 min-w-max">
          {formatMonthLabel(filter.anchor)}
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            const newDate = new Date(filter.anchor);
            newDate.setMonth(newDate.getMonth() + 1);
            onChange({ ...filter, anchor: newDate });
          }}
          className="h-7 w-7 p-0"
        >
          ›
        </Button>
      </div>

      <span className="hidden md:inline-block h-5 w-px bg-[color:var(--rule)]" />

      <div className="flex items-center gap-1">
        {(["day", "week", "month", "year"] as const).map((gran) => (
          <Button
            key={gran}
            variant={filter.granularity === gran ? "secondary" : "ghost"}
            size="sm"
            onClick={() => {
              onChange({ ...filter, granularity: gran });
            }}
            className="h-7 px-2 text-[length:var(--fs-eyebrow)]"
          >
            {gran === "day" ? "Dia" : gran === "week" ? "Semana" : gran === "month" ? "Mês" : "Ano"}
          </Button>
        ))}
        <Button
          variant={filter.granularity === "all" ? "secondary" : "ghost"}
          size="sm"
          onClick={() => {
            onChange({ ...filter, granularity: "all" });
          }}
          className="h-7 px-2 text-[length:var(--fs-eyebrow)]"
        >
          Todos
        </Button>
      </div>

      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          onChange({
            granularity: "day",
            anchor: new Date(),
          });
        }}
        className="h-7 px-2 text-[length:var(--fs-eyebrow)] ml-auto"
      >
        Hoje
      </Button>
    </div>
  );
}
