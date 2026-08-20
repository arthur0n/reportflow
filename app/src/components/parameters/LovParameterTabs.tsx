// Active / Inactive tab strip for LOV-backed parameter pages. Inactive count
// excludes system rows (a tenant can't deactivate them); active count
// includes both. Pure presentation — page owns the tab state.

import type { ReactElement } from "react";
import { cn } from "@/lib/utils";
import type { LovParameterRow } from "./LovParameterTable";

export type LovParameterTab = "ativos" | "inativos";

type Props = {
  rows: ReadonlyArray<LovParameterRow>;
  tab: LovParameterTab;
  onTabChange: (tab: LovParameterTab) => void;
  ariaLabel: string;
};

export function LovParameterTabs({ rows, tab, onTabChange, ariaLabel }: Props): ReactElement {
  const activeCount = rows.filter((r) => r.deletedAt === null).length;
  const inactiveCount = rows.filter((r) => r.deletedAt !== null && !r.isSystem).length;

  const tabs: { key: LovParameterTab; label: string; count: number }[] = [
    { key: "ativos", label: "Ativos", count: activeCount },
    { key: "inativos", label: "Inativos", count: inactiveCount },
  ];

  return (
    <nav className="flex gap-6 border-b border-[color:var(--rule)] pb-3" aria-label={ariaLabel}>
      {tabs.map((t) => {
        const active = tab === t.key;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => {
              onTabChange(t.key);
            }}
            className={cn(
              "relative inline-flex items-baseline gap-1.5",
              "text-[length:var(--fs-eyebrow)] uppercase tracking-[0.14em] font-[550]",
              "pb-3 -mb-3 transition-colors",
              active
                ? "text-[color:var(--ink)]"
                : "text-[color:var(--ink-mute)] hover:text-[color:var(--ink-soft)]",
            )}
          >
            <span>{t.label}</span>
            <span className="tabular-nums text-[color:var(--ink-mute)]">{t.count}</span>
            {active && (
              <span
                aria-hidden
                className="absolute left-0 right-0 bottom-0 h-[2px] bg-[color:var(--accent)]"
              />
            )}
          </button>
        );
      })}
    </nav>
  );
}
