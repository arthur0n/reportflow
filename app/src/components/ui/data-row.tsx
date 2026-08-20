import type { ReactElement, ReactNode } from "react";
import { cn } from "@/lib/utils";

type DataRowProps = {
  eyebrow?: ReactNode;
  primary: ReactNode;
  secondary?: ReactNode;
  value?: ReactNode;
  valueTone?: "positive" | "negative" | "default" | "mute";
  right?: ReactNode;
  className?: string;
  interactive?: boolean;
  onClick?: () => void;
};

const VALUE_TONE: Record<NonNullable<DataRowProps["valueTone"]>, string> = {
  positive: "text-[color:var(--positive)]",
  negative: "text-[color:var(--negative)]",
  default: "text-[color:var(--ink)]",
  mute: "text-[color:var(--ink-mute)]",
};

export function DataRow({
  eyebrow,
  primary,
  secondary,
  value,
  valueTone = "default",
  right,
  className,
  interactive = false,
  onClick,
}: DataRowProps): ReactElement {
  const content = (
    <div
      className={cn(
        "group grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-0.5 py-2.5",
        "border-b border-[color:var(--rule)] last:border-b-0",
        interactive && "cursor-pointer transition-colors hover:bg-[color:var(--paper-sink)]",
        className,
      )}
    >
      <div className="flex flex-col min-w-0">
        {eyebrow !== undefined && (
          <span className="text-[length:var(--fs-eyebrow)] uppercase tracking-[0.12em] font-[550] text-[color:var(--ink-mute)]">
            {eyebrow}
          </span>
        )}
        <span className="truncate text-[length:var(--fs-body)] font-[450] text-[color:var(--ink)]">
          {primary}
        </span>
        {secondary !== undefined && (
          <span className="truncate text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
            {secondary}
          </span>
        )}
      </div>
      {(value !== undefined || right !== undefined) && (
        <div className="flex items-center gap-3 justify-self-end">
          {value !== undefined && (
            <span
              className={cn(
                "tabular-nums text-[length:var(--fs-body)] font-[500]",
                VALUE_TONE[valueTone],
              )}
            >
              {value}
            </span>
          )}
          {right !== undefined && right}
        </div>
      )}
    </div>
  );

  if (interactive && onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] rounded-[var(--radius-sm)]"
      >
        {content}
      </button>
    );
  }
  return content;
}
