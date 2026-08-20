import type { ReactElement, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Eyebrow } from "@/components/ui/eyebrow";

type MetricProps = {
  label: string;
  value: ReactNode;
  size?: "hero" | "display" | "compact";
  delta?: { value: string; direction: "up" | "down" | "flat" } | null;
  hint?: string;
  pending?: boolean;
  className?: string;
};

const ARROW: Record<"up" | "down" | "flat", string> = {
  up: "↑",
  down: "↓",
  flat: "→",
};

const DELTA_TONE: Record<"up" | "down" | "flat", string> = {
  up: "text-[color:var(--positive)]",
  down: "text-[color:var(--negative)]",
  flat: "text-[color:var(--ink-mute)]",
};

export function Metric({
  label,
  value,
  size = "display",
  delta,
  hint,
  pending = false,
  className,
}: MetricProps): ReactElement {
  const valueSize =
    size === "hero"
      ? "text-[length:var(--fs-hero)] font-[350]"
      : size === "compact"
        ? "text-[length:var(--fs-section)] font-[450]"
        : "text-[length:var(--fs-display)] font-[450]";

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Eyebrow>{label}</Eyebrow>
      <div
        className={cn(
          "font-serif leading-[1.05] tracking-[-0.02em] tabular-nums",
          valueSize,
          pending && "text-[color:var(--ink-mute)] italic font-[400]",
        )}
      >
        {pending ? "—" : value}
      </div>
      {delta && !pending && (
        <div className={cn("flex items-center gap-1.5 text-[length:var(--fs-body-sm)]", DELTA_TONE[delta.direction])}>
          <span aria-hidden className="font-sans">
            {ARROW[delta.direction]}
          </span>
          <span className="tabular-nums font-[500]">{delta.value}</span>
        </div>
      )}
      {hint && (
        <span className="text-[length:var(--fs-body-sm)] italic text-[color:var(--ink-mute)]">
          {hint}
        </span>
      )}
    </div>
  );
}
