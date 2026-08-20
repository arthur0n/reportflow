// Owns the recurrence-config state shared by every host that adds recurrence
// to a transaction-shaped form (imports row, transaction row, manual CRUD
// modal, future report-tab callers, …). Re-seeds on `open` transitions and
// exposes `buildConfig` returning `{ ok, value | error }` so the host can
// validate before submit and show field-level errors in the recurrence UI.

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { RecurrenceConfig } from "@shared/validation/recurrence-schemas";

export type DialogMode = "dont-repeat" | "finite" | "always";

export type RecurrenceConfigState = {
  mode: DialogMode;
  setMode: Dispatch<SetStateAction<DialogMode>>;
  recurrencePatternId: string | null;
  setRecurrencePatternId: Dispatch<SetStateAction<string | null>>;
  repeatCount: number;
  setRepeatCount: Dispatch<SetStateAction<number>>;
  // null means "no recurrence requested" (mode === 'dont-repeat'); the host
  // should skip the recurrence mutation arm and call plain create.
  buildConfig: () => { ok: true; value: RecurrenceConfig | null } | { ok: false; error: string };
};

const DEFAULT_REPEAT_COUNT = 11;

export function useRecurrenceConfigState(args: {
  open: boolean;
  // Seed mode on open. Defaults to 'finite' for new dialogs and 'dont-repeat'
  // for hosts that hide the toggle until the user opts in.
  defaultMode?: DialogMode;
}): RecurrenceConfigState {
  const { open, defaultMode = "finite" } = args;

  const [mode, setMode] = useState<DialogMode>(defaultMode);
  const [recurrencePatternId, setRecurrencePatternId] = useState<string | null>(null);
  const [repeatCount, setRepeatCount] = useState<number>(DEFAULT_REPEAT_COUNT);

  useEffect(() => {
    if (!open) return;
    setMode(defaultMode);
    setRecurrencePatternId(null);
    setRepeatCount(DEFAULT_REPEAT_COUNT);
  }, [open, defaultMode]);

  function buildConfig():
    { ok: true; value: RecurrenceConfig | null } | { ok: false; error: string } {
    if (mode === "dont-repeat") return { ok: true, value: null };
    if (recurrencePatternId === null) {
      return { ok: false, error: "Selecione a periodicidade." };
    }
    if (mode === "finite") {
      if (repeatCount < 1 || repeatCount > 120) {
        return { ok: false, error: "Quantidade deve estar entre 1 e 120." };
      }
      return {
        ok: true,
        value: { mode: "finite", recurrencePatternId, repeatCount },
      };
    }
    return { ok: true, value: { mode: "always", recurrencePatternId } };
  }

  return {
    mode,
    setMode,
    recurrencePatternId,
    setRecurrencePatternId,
    repeatCount,
    setRepeatCount,
    buildConfig,
  };
}
