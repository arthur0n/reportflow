// Provider for the global month/year the header PeriodSelector controls.
// Month-scoped pages read it via usePeriod (app/src/shared/period.ts).

import { useMemo, useState, type ReactNode } from "react";
import { PeriodContext, type Period } from "@/shared/period";

export function PeriodProvider({ children }: { children: ReactNode }): ReactNode {
  const now = new Date();
  const [period, setPeriod] = useState<Period>({
    month: now.getMonth() + 1,
    year: now.getFullYear(),
  });
  const value = useMemo(() => ({ period, setPeriod }), [period]);
  return <PeriodContext.Provider value={value}>{children}</PeriodContext.Provider>;
}
