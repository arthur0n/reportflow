// Global month/year period: context object, consumer hook and helpers.
// The provider component lives in period-context.tsx (react-refresh wants
// component files to export only components).

import { createContext, useContext } from "react";

export type Period = { month: number; year: number };

export type PeriodContextValue = {
  period: Period;
  setPeriod: (p: Period) => void;
};

export const PeriodContext = createContext<PeriodContextValue | null>(null);

export function usePeriod(): PeriodContextValue {
  const ctx = useContext(PeriodContext);
  if (ctx === null) throw new Error("usePeriod requires PeriodProvider");
  return ctx;
}

/** ISO [first day, last day] of the period's month. */
export function periodRange(period: Period): { from: string; to: string } {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const lastDay = new Date(period.year, period.month, 0).getDate();
  return {
    from: `${String(period.year)}-${pad(period.month)}-01`,
    to: `${String(period.year)}-${pad(period.month)}-${pad(lastDay)}`,
  };
}
