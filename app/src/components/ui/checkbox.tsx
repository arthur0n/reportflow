import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";

import { cn } from "@/lib/utils";

const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "grid place-content-center peer",
      "h-[14px] w-[14px] shrink-0 rounded-[2px]",
      "border border-[color:var(--rule-strong)] bg-transparent",
      "transition-[background-color,border-color] duration-100",
      "hover:border-[color:var(--ink)]",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[color:var(--paper)]",
      "disabled:cursor-not-allowed disabled:opacity-50",
      "data-[state=checked]:bg-[color:var(--ink)] data-[state=checked]:border-[color:var(--ink)] data-[state=checked]:text-[color:var(--paper)]",
      "data-[state=indeterminate]:bg-[color:var(--ink)] data-[state=indeterminate]:border-[color:var(--ink)] data-[state=indeterminate]:text-[color:var(--paper)]",
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className={cn("grid place-content-center text-current")}>
      {props.checked === "indeterminate" ? (
        <Minus className="h-3 w-3 stroke-[2.5]" />
      ) : (
        <Check className="h-3 w-3 stroke-[2.5]" />
      )}
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;

export { Checkbox };
