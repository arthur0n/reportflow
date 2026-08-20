import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/* Editorial badges — not pills. Small caps, tight, no decorative glow.
 * - `default` / `outline`: hairline-bordered, paper background, ink text
 * - `accent` / `destructive` / `success` / `warning`: 1px tinted left rule + tinted wash
 * - `solid`: fully filled small-caps tag used for dense status columns
 */
const badgeVariants = cva(
  [
    "inline-flex items-center gap-1.5",
    "rounded-[var(--radius-sm)]",
    "px-1.5 py-0.5",
    "text-[length:var(--fs-eyebrow)] font-[550] uppercase tracking-[0.1em]",
    "transition-colors",
  ].join(" "),
  {
    variants: {
      variant: {
        default:
          "border border-[color:var(--rule-strong)] bg-transparent text-[color:var(--ink-soft)]",
        outline:
          "border border-[color:var(--rule)] bg-transparent text-[color:var(--ink-mute)]",
        accent:
          "border border-[color:var(--accent)]/30 bg-[color:var(--accent-wash)] text-[color:var(--accent-deep)]",
        success:
          "border border-[color:var(--positive)]/30 bg-[color:var(--positive)]/10 text-[color:var(--positive)]",
        destructive:
          "border border-[color:var(--negative)]/30 bg-[color:var(--negative)]/8 text-[color:var(--negative)]",
        warning:
          "border border-[color:var(--caution)]/40 bg-[color:var(--caution)]/12 text-[color:oklch(0.4_0.08_75)]",
        secondary:
          "border border-[color:var(--rule)] bg-[color:var(--paper-sink)] text-[color:var(--ink-soft)]",
        solid:
          "border border-[color:var(--ink)] bg-[color:var(--ink)] text-[color:var(--paper)]",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps): React.ReactElement {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
