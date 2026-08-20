import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

/* Editorial ledger buttons —
 * - `default`: ink fill, paper text, tight 4px radius
 * - `outline`: paper with 1px rule, hover fills paper-sink
 * - `accent`: vermillion fill for truly critical actions
 * - `ghost`: bare, underline on hover
 * - `link`: vermillion, underline-offset-4
 * - `destructive`: negative red fill
 */
const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap",
    "rounded-[var(--radius-md)] font-[500] tracking-[-0.005em]",
    "text-[length:var(--fs-body-sm)]",
    "transition-[background-color,color,border-color] duration-150",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--paper)]",
    "disabled:pointer-events-none disabled:opacity-55",
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        default:
          "bg-[color:var(--ink)] text-[color:var(--paper)] hover:bg-[color:var(--ink-soft)] border border-[color:var(--ink)]",
        outline:
          "bg-transparent text-[color:var(--ink)] border border-[color:var(--rule-strong)] hover:bg-[color:var(--paper-sink)] hover:border-[color:var(--ink)]",
        accent:
          "bg-[color:var(--accent)] text-[color:var(--paper)] border border-[color:var(--accent)] hover:bg-[color:var(--accent-deep)]",
        destructive:
          "bg-[color:var(--negative)] text-[color:var(--paper)] border border-[color:var(--negative)] hover:bg-[color:var(--negative)]/90",
        secondary:
          "bg-[color:var(--paper-sink)] text-[color:var(--ink)] border border-[color:var(--rule)] hover:bg-[color:var(--paper-edge)]",
        ghost:
          "bg-transparent text-[color:var(--ink)] hover:bg-[color:var(--paper-sink)] border border-transparent",
        link:
          "bg-transparent text-[color:var(--accent)] hover:text-[color:var(--accent-deep)] underline-offset-4 hover:underline border border-transparent p-0 h-auto",
      },
      size: {
        default: "h-9 px-4",
        sm: "h-8 px-3 text-[length:var(--fs-eyebrow)] uppercase tracking-[0.08em] font-[550]",
        lg: "h-10 px-5 text-[length:var(--fs-body)]",
        icon: "h-9 w-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
