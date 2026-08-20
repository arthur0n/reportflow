import type { ReactElement, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Eyebrow } from "@/components/ui/eyebrow";

type PageHeaderProps = {
  eyebrow?: string;
  title: string;
  lede?: ReactNode;
  aside?: ReactNode;
  className?: string;
};

export function PageHeader({
  eyebrow,
  title,
  lede,
  aside,
  className,
}: PageHeaderProps): ReactElement {
  return (
    <header
      className={cn(
        "flex flex-wrap items-end justify-between gap-x-8 gap-y-3 pb-3",
        "border-b border-[color:var(--rule-strong)]",
        className,
      )}
    >
      <div className="flex flex-col gap-1 max-w-2xl min-w-0">
        {eyebrow !== undefined && <Eyebrow>{eyebrow}</Eyebrow>}
        <h1 className="font-serif text-[1.625rem] lg:text-[1.875rem] font-[500] leading-[1.1] tracking-[-0.015em] text-[color:var(--ink)]">
          {title}
        </h1>
        {lede !== undefined && (
          <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)] leading-[1.5] max-w-prose mt-0.5">
            {lede}
          </p>
        )}
      </div>
      {aside !== undefined && <div className="flex items-center gap-3 shrink-0">{aside}</div>}
    </header>
  );
}
