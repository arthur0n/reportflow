import * as React from "react";

import { cn } from "@/lib/utils";

/* Editorial underline-style input. No box, hairline at the bottom,
 * accent underline animates in on focus. */
const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-9 w-full bg-transparent px-1 py-1",
          "text-[length:var(--fs-body)] text-[color:var(--ink)]",
          "font-sans tabular-nums",
          "border-0 border-b border-[color:var(--rule-strong)]",
          "transition-[border-color,box-shadow] duration-150",
          "placeholder:text-[color:var(--ink-mute)] placeholder:font-[400]",
          "focus:outline-none focus-visible:outline-none",
          "focus:border-[color:var(--accent)] focus:shadow-[0_1px_0_0_var(--accent)]",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "file:border-0 file:bg-transparent file:text-[length:var(--fs-body-sm)] file:font-[500] file:text-[color:var(--ink)]",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
