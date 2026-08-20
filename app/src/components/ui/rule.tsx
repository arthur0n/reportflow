import * as React from "react";
import { cn } from "@/lib/utils";

type RuleProps = React.HTMLAttributes<HTMLHRElement> & {
  strong?: boolean;
  orientation?: "horizontal" | "vertical";
};

export function Rule({
  className,
  strong = false,
  orientation = "horizontal",
  ...props
}: RuleProps): React.ReactElement {
  const color = strong ? "var(--rule-strong)" : "var(--rule)";
  if (orientation === "vertical") {
    return (
      <span
        role="separator"
        aria-orientation="vertical"
        className={cn("inline-block h-full w-px", className)}
        style={{ background: color }}
        {...(props as React.HTMLAttributes<HTMLSpanElement>)}
      />
    );
  }
  return (
    <hr
      className={cn("border-0 h-px w-full", className)}
      style={{ background: color }}
      {...props}
    />
  );
}
