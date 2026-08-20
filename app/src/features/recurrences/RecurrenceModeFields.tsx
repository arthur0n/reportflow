// Mode + pattern controls for the recurrence dialog. Pattern is picked from
// the system RECURRENCE_PATTERN LOV (no tenant overrides ever) — the row's
// `description` carries the iCalendar RRULE the engine parses on submit.

import type { ReactElement } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useLov } from "@/hooks/use-lov";
import type { RecurrenceMode } from "@shared/validation/recurrence-schemas";

export type DialogMode = "dont-repeat" | RecurrenceMode;

export function RecurrenceModeFields({
  mode,
  setMode,
  recurrencePatternId,
  setRecurrencePatternId,
  repeatCount,
  setRepeatCount,
}: {
  mode: DialogMode;
  setMode: (m: DialogMode) => void;
  recurrencePatternId: string | null;
  setRecurrencePatternId: (id: string | null) => void;
  repeatCount: number;
  setRepeatCount: (n: number) => void;
}): ReactElement {
  const patterns = useLov("RECURRENCE_PATTERN");
  const showPattern = mode !== "dont-repeat";
  const showRepeatCount = mode === "finite";
  return (
    <div className="flex flex-col gap-3 rounded-md border p-3 bg-[color:var(--paper-sink)]/30">
      <div className="flex flex-wrap gap-3">
        <ModeRadio value="dont-repeat" current={mode} onSelect={setMode} label="Não repetir" />
        <ModeRadio value="finite" current={mode} onSelect={setMode} label="Repetir + vezes" />
        <ModeRadio value="always" current={mode} onSelect={setMode} label="Sempre" />
      </div>

      {showPattern && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="rec-pattern">Periodicidade</Label>
            <Select
              value={recurrencePatternId ?? ""}
              onValueChange={(v) => {
                setRecurrencePatternId(v.length > 0 ? v : null);
              }}
            >
              <SelectTrigger id="rec-pattern" className="w-48">
                <SelectValue placeholder="Selecionar…" />
              </SelectTrigger>
              <SelectContent>
                {patterns.items.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {showRepeatCount && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rec-repeat-count">Quantidade</Label>
              <Input
                id="rec-repeat-count"
                type="number"
                min={1}
                max={120}
                value={repeatCount}
                onChange={(e) => {
                  const n = Number.parseInt(e.target.value, 10);
                  if (Number.isFinite(n)) setRepeatCount(n);
                }}
                className="w-24"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ModeRadio({
  value,
  current,
  onSelect,
  label,
}: {
  value: DialogMode;
  current: DialogMode;
  onSelect: (m: DialogMode) => void;
  label: string;
}): ReactElement {
  const id = `rec-mode-${value}`;
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm cursor-pointer">
      <input
        id={id}
        type="radio"
        name="rec-mode"
        value={value}
        checked={current === value}
        onChange={() => {
          onSelect(value);
        }}
      />
      <span>{label}</span>
    </label>
  );
}
