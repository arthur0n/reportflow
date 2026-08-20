import type { ReactElement, ReactNode } from "react";
import { Link } from "wouter";
import { Eyebrow } from "@/components/ui/eyebrow";

type AuthShellProps = {
  title: string;
  description: string;
  children: ReactNode;
};

export function AuthShell({ title, description, children }: AuthShellProps): ReactElement {
  return (
    <div className="min-h-screen bg-[color:var(--paper)] grid grid-cols-1 lg:grid-cols-[1.1fr_1fr]">
      {/* Left — editorial masthead */}
      <aside className="relative flex flex-col justify-between bg-[color:var(--paper-sink)]/60 border-b lg:border-b-0 lg:border-r border-[color:var(--rule)] px-8 lg:px-14 py-10 lg:py-14">
        <header className="flex flex-col gap-2">
          <Eyebrow>ReportFlow · Gestão financeira</Eyebrow>
          <Link
            href="/"
            className="font-serif italic font-[500] text-[clamp(2rem,1.4rem+2vw,3rem)] leading-none tracking-[-0.02em] text-[color:var(--ink)] hover:text-[color:var(--accent)] transition-colors w-fit"
          >
            ReportFlow
          </Link>
        </header>

        <div className="flex flex-col gap-6 max-w-lg pt-10 lg:pt-0">
          <blockquote className="font-serif text-[clamp(1.5rem,1.1rem+1.5vw,2.25rem)] font-[400] leading-[1.2] tracking-[-0.012em] text-[color:var(--ink)]">
            <span className="text-[color:var(--accent)] font-serif italic font-[500]">
              Do caixa à DRE
            </span>
            , em um só lugar — com a mesma clareza de uma página de jornal, só que ao vivo.
          </blockquote>
          <div className="flex flex-col gap-3 pt-4 border-t border-[color:var(--rule)]">
            <Eyebrow>Sobre</Eyebrow>
            <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)] leading-[1.6] max-w-md">
              Construído para consultorias e restaurantes que vivem no fluxo. Multi-unidade,
              multi-tenant, importação de OFX com quarentena, DRE gerencial gerado automaticamente.
            </p>
          </div>
        </div>

        <footer className="flex flex-wrap items-baseline justify-between gap-3 pt-10 text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
          <span className="font-serif italic">Brasil · pt-BR</span>
          <span className="tabular-nums">v0.1 · MVP</span>
        </footer>
      </aside>

      {/* Right — form */}
      <main className="flex items-center justify-center px-6 lg:px-14 py-10 lg:py-14">
        <div className="w-full max-w-[420px] flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <Eyebrow>{title}</Eyebrow>
            <h1 className="font-serif text-[length:var(--fs-display)] font-[500] leading-[1.05] tracking-[-0.018em] text-[color:var(--ink)]">
              {title}
            </h1>
            <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)]">
              {description}
            </p>
          </div>
          <div className="pt-2">{children}</div>
        </div>
      </main>
    </div>
  );
}
