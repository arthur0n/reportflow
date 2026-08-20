import type { ReactElement } from "react";
import { Link } from "wouter";
import { ArrowUpRight } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { Section } from "@/components/ui/section";
import { Metric } from "@/components/ui/metric";
import { DataRow } from "@/components/ui/data-row";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Rule } from "@/components/ui/rule";
import { Button } from "@/components/ui/button";
import { trpc } from "@/shared/lib/trpc";
import { formatCurrency, formatDate } from "@/shared/lib/format";

function centsToReais(cents: bigint | number | null | undefined): number | null {
  if (cents === null || cents === undefined) return null;
  return Number(cents) / 100;
}

function signedCurrency(value: number | null): string {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${formatCurrency(Math.abs(value))}`;
}

export function DashboardPage(): ReactElement {
  const meQuery = trpc.users.me.useQuery();
  const txQuery = trpc.transactions.list.useQuery();

  const tx = txQuery.data ?? [];
  const recent = tx.slice(0, 8);

  return (
    <AppLayout>
      <PageHeader
        eyebrow="Visão geral"
        title="Painel"
        lede="Visão geral do mês — suas entradas, saídas e pendências."
      />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-x-10 gap-y-12">
        {/* Main column */}
        <div className="lg:col-span-8 flex flex-col gap-12">
          {/* Hero metric */}
          <section className="flex flex-col gap-3">
            <Eyebrow>Faturamento · mês corrente</Eyebrow>
            <div className="font-serif text-[length:var(--fs-hero)] font-[350] leading-[0.95] tracking-[-0.03em] text-[color:var(--ink)] tabular-nums">
              <span className="text-[0.55em] align-top mr-2 text-[color:var(--ink-mute)]">R$</span>
              <span className="italic text-[color:var(--ink-mute)]">—</span>
            </div>
            <p className="text-[length:var(--fs-body-sm)] italic text-[color:var(--ink-soft)] max-w-md">
              Aguardando a revisão do DRE (R-02). Os lançamentos já estão no livro de transações
              abaixo.
            </p>
          </section>

          {/* Supporting metrics */}
          <section className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-5 pt-6 border-t border-[color:var(--rule)]">
            <Metric label="CMV %" value="—" pending size="compact" />
            <Metric label="Margem contr." value="—" pending size="compact" />
            <Metric label="Lucro oper." value="—" pending size="compact" />
            <Metric label="Ticket médio" value="—" pending size="compact" />
          </section>

          {/* Recent activity */}
          <Section
            eyebrow="Últimos lançamentos"
            title="Livro do mês"
            aside={
              <Link href="/transactions">
                <Button variant="ghost" size="sm">
                  Ver tudo
                  <ArrowUpRight className="h-3 w-3" />
                </Button>
              </Link>
            }
          >
            {txQuery.isLoading && (
              <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
                Carregando…
              </p>
            )}
            {txQuery.error && (
              <p className="text-[length:var(--fs-body-sm)] text-[color:var(--negative)]">
                Erro: {txQuery.error.message}
              </p>
            )}
            {!txQuery.isLoading && recent.length === 0 && (
              <div className="py-10 text-center flex flex-col gap-2">
                <p className="font-serif text-[length:var(--fs-section)] font-[450] text-[color:var(--ink-soft)]">
                  Nenhum lançamento ainda.
                </p>
                <p className="text-[length:var(--fs-body-sm)] italic text-[color:var(--ink-mute)]">
                  Traga um extrato OFX para{" "}
                  <Link
                    href="/imports"
                    className="text-[color:var(--accent)] hover:underline underline-offset-4"
                  >
                    Importações
                  </Link>{" "}
                  e deixa a gente organizar.
                </p>
              </div>
            )}
            {recent.length > 0 && (
              <div className="flex flex-col">
                {recent.map((t) => {
                  const real = centsToReais(t.actualAmount) ?? centsToReais(t.forecastAmount);
                  const tone =
                    real !== null && real < 0
                      ? "negative"
                      : real !== null && real > 0
                        ? "positive"
                        : "mute";
                  return (
                    <DataRow
                      key={t.id}
                      eyebrow={`${t.statusCode ?? ""} · ${formatDate(t.dueDate)}`}
                      primary={t.description ?? "Sem descrição"}
                      secondary={`Competência ${formatDate(t.accrualDate)}`}
                      value={signedCurrency(real)}
                      valueTone={tone}
                    />
                  );
                })}
              </div>
            )}
          </Section>
        </div>

        {/* Right rail */}
        <aside className="lg:col-span-4 flex flex-col gap-10 lg:pl-6 lg:border-l lg:border-[color:var(--rule)]">
          <section className="flex flex-col gap-3">
            <Eyebrow>Sessão</Eyebrow>
            {meQuery.isLoading && (
              <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
                Carregando…
              </p>
            )}
            {meQuery.error && (
              <p className="text-[length:var(--fs-body-sm)] text-[color:var(--negative)]">
                Erro: {meQuery.error.message}
              </p>
            )}
            {meQuery.data && (
              <dl className="flex flex-col gap-2.5 text-[length:var(--fs-body-sm)]">
                {Object.entries(meQuery.data)
                  .filter(([, v]) => typeof v !== "object")
                  .map(([k, v]) => (
                    <div
                      key={k}
                      className="flex items-baseline justify-between gap-4 border-b border-[color:var(--rule)] pb-2 last:border-b-0"
                    >
                      <dt className="text-[length:var(--fs-eyebrow)] uppercase tracking-[0.12em] font-[550] text-[color:var(--ink-mute)]">
                        {k}
                      </dt>
                      <dd className="tabular-nums text-[color:var(--ink)] truncate max-w-[60%]">
                        {String(v)}
                      </dd>
                    </div>
                  ))}
              </dl>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <Eyebrow>Próximos vencimentos</Eyebrow>
            <p className="font-serif text-[length:var(--fs-section)] font-[450] italic text-[color:var(--ink-mute)]">
              aguardando cálculo
            </p>
            <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)]">
              Disponível após o primeiro período com lançamentos conciliados.
            </p>
          </section>

          <section className="flex flex-col gap-3">
            <Eyebrow>Atalhos</Eyebrow>
            <Rule />
            <div className="flex flex-col">
              <Link
                href="/imports"
                className="flex items-center justify-between py-3 border-b border-[color:var(--rule)] last:border-b-0 hover:text-[color:var(--accent)] transition-colors"
              >
                <span className="font-serif font-[450]">Nova importação</span>
                <ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
              <Link
                href="/transactions"
                className="flex items-center justify-between py-3 border-b border-[color:var(--rule)] last:border-b-0 hover:text-[color:var(--accent)] transition-colors"
              >
                <span className="font-serif font-[450]">Livro de lançamentos</span>
                <ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
              <Link
                href="/reports"
                className="flex items-center justify-between py-3 border-b border-[color:var(--rule)] last:border-b-0 hover:text-[color:var(--accent)] transition-colors"
              >
                <span className="font-serif font-[450]">DRE gerencial</span>
                <ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </section>
        </aside>
      </div>
    </AppLayout>
  );
}
