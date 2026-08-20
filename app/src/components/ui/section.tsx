import type { ReactElement, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Rule } from "@/components/ui/rule";

type SectionProps = {
  eyebrow?: string;
  title?: ReactNode;
  description?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  bare?: boolean;
  divider?: boolean;
};

export function Section({
  eyebrow,
  title,
  description,
  aside,
  children,
  className,
  bare = false,
  divider = true,
}: SectionProps): ReactElement {
  return (
    <section className={cn("flex flex-col", !bare && "gap-4", className)}>
      {(eyebrow !== undefined || title !== undefined || aside !== undefined) && (
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            {eyebrow !== undefined && <Eyebrow>{eyebrow}</Eyebrow>}
            {title !== undefined && (
              <h2
                className={cn(
                  "font-serif text-[length:var(--fs-section)] font-[500] leading-[1.1] tracking-[-0.012em]",
                  "text-[color:var(--ink)]",
                )}
              >
                {title}
              </h2>
            )}
            {description !== undefined && (
              <p className="max-w-prose text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)]">
                {description}
              </p>
            )}
          </div>
          {aside !== undefined && <div className="flex items-center gap-3">{aside}</div>}
        </header>
      )}
      {divider && <Rule strong />}
      {children}
    </section>
  );
}
