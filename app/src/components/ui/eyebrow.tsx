import * as React from "react";
import { cn } from "@/lib/utils";

type EyebrowProps = React.HTMLAttributes<HTMLSpanElement> & {
  tone?: "default" | "accent" | "positive" | "negative" | "ink";
};

const TONES: Record<NonNullable<EyebrowProps["tone"]>, string> = {
  default: "text-[color:var(--ink-mute)]",
  ink: "text-[color:var(--ink)]",
  accent: "text-[color:var(--accent)]",
  positive: "text-[color:var(--positive)]",
  negative: "text-[color:var(--negative)]",
};

export function Eyebrow({
  className,
  tone = "default",
  ...props
}: EyebrowProps): React.ReactElement {
  return (
    <span
      className={cn(
        "inline-block font-sans uppercase",
        "text-[length:var(--fs-eyebrow)] font-[550]",
        "tracking-[0.14em]",
        TONES[tone],
        className,
      )}
      {...props}
    />
  );
}
