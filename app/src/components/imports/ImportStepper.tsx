import type { ReactElement } from "react";
import { cn } from "@/lib/utils";

export type ImportStep = "upload" | "review" | "summary" | "done";

export type StepperStep = { key: string; label: string };

const BANK_STEPS: StepperStep[] = [
  { key: "upload", label: "Enviar" },
  { key: "review", label: "Revisar" },
  { key: "summary", label: "Resumo" },
  { key: "done", label: "Concluído" },
];

export function ImportStepper({
  currentStep,
  steps = BANK_STEPS,
}: {
  currentStep: string;
  steps?: StepperStep[];
}): ReactElement {
  const currentIdx = steps.findIndex((s) => s.key === currentStep);

  return (
    <nav aria-label="Progresso da importação" className="mb-8">
      <ol className={cn("grid gap-0", steps.length === 3 ? "grid-cols-3" : "grid-cols-4")}>
        {steps.map((step, idx) => {
          const cmp = idx - currentIdx;
          const state = cmp < 0 ? "done" : cmp === 0 ? "active" : "upcoming";
          return (
            <li key={step.key} className="flex flex-col gap-2.5">
              <div className="relative flex items-center">
                {/* Connector line */}
                <div
                  className={cn(
                    "absolute left-0 right-0 top-1/2 h-px -translate-y-1/2",
                    state === "done" ? "bg-[color:var(--ink)]" : "bg-[color:var(--rule)]",
                  )}
                  aria-hidden
                />
                {/* Dot */}
                <span
                  className={cn(
                    "relative z-10 inline-block h-2 w-2 rounded-full",
                    state === "done" && "bg-[color:var(--ink)]",
                    state === "active" &&
                      "bg-[color:var(--accent)] ring-4 ring-[color:var(--accent-wash)]",
                    state === "upcoming" &&
                      "bg-[color:var(--paper)] border border-[color:var(--rule-strong)]",
                  )}
                  aria-current={state === "active" ? "step" : undefined}
                />
              </div>
              <div className="flex items-baseline gap-1.5">
                <span className="text-[length:var(--fs-eyebrow)] tabular-nums text-[color:var(--ink-mute)] font-[550]">
                  {String(idx + 1).padStart(2, "0")}
                </span>
                <span
                  className={cn(
                    "text-[length:var(--fs-eyebrow)] uppercase tracking-[0.14em] font-[550]",
                    state === "active" && "text-[color:var(--accent)]",
                    state === "done" && "text-[color:var(--ink)]",
                    state === "upcoming" && "text-[color:var(--ink-mute)]",
                  )}
                >
                  {step.label}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
