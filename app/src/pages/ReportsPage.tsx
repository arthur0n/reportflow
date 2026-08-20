import type { ReactElement } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Rule } from "@/components/ui/rule";
import { cn } from "@/lib/utils";

type DreRow =
  | { kind: "group"; code: string; label: string; sign: "+" | "−" }
  | { kind: "subtotal"; label: string; formula: string };

const DRE_ROWS: DreRow[] = [
  { kind: "group", code: "F", label: "Faturamento", sign: "+" },
  { kind: "group", code: "CMV", label: "Custo das Mercadorias Vendidas", sign: "−" },
  { kind: "subtotal", label: "Lucro Bruto", formula: "F − CMV" },
  { kind: "group", code: "CVI", label: "Custos Variáveis e de Instalação", sign: "−" },
  { kind: "subtotal", label: "Margem de Contribuição", formula: "LB − CVI" },
  { kind: "group", code: "CF", label: "Custos Fixos", sign: "−" },
  { kind: "subtotal", label: "Lucro Operacional", formula: "MC − CF" },
];

const OTHER_REPORTS = [
  "DRE por unidade",
  "Evolução de custos por categoria",
  "Markup por grupo",
  "Painel executivo (ratios)",
  "Fluxo de caixa consolidado",
];

export function ReportsPage(): ReactElement {
  return (
    <AppLayout>
      <PageHeader
        eyebrow="Demonstrativo"
        title="Relatórios"
        lede="DRE gerencial e análises de custo — cálculo liberado após R-02."
      />

      {/* DRE ledger */}
      <article className="grid grid-cols-1 lg:grid-cols-12 gap-x-10 gap-y-6">
        <header className="lg:col-span-12 flex items-end justify-between gap-6 pb-2">
          <div className="flex flex-col gap-1">
            <Eyebrow>DRE gerencial — consolidado</Eyebrow>
            <h2 className="font-serif text-[1.625rem] font-[500] leading-[1.05] tracking-[-0.018em]">
              Demonstração do Resultado do Exercício
            </h2>
          </div>
          <span className="text-[length:var(--fs-body-sm)] italic text-[color:var(--ink-mute)] hidden md:block">
            competência mensal · todas as unidades
          </span>
        </header>

        <div className="lg:col-span-12">
          <table className="w-full border-t border-b border-[color:var(--ink)]">
            <thead>
              <tr className="border-b border-[color:var(--rule-strong)]">
                <th className="text-left py-3 pr-4 w-[14rem]">
                  <Eyebrow>Grupo</Eyebrow>
                </th>
                <th className="text-left py-3 pr-4">
                  <Eyebrow>Conta</Eyebrow>
                </th>
                <th className="text-right py-3 pr-4 w-[7rem]">
                  <Eyebrow>Mês corrente</Eyebrow>
                </th>
                <th className="text-right py-3 pr-4 w-[7rem]">
                  <Eyebrow>Mês anterior</Eyebrow>
                </th>
                <th className="text-right py-3 pr-0 w-[5rem]">
                  <Eyebrow>Δ</Eyebrow>
                </th>
              </tr>
            </thead>
            <tbody className="font-serif">
              {DRE_ROWS.map((row, i) => {
                if (row.kind === "subtotal") {
                  return (
                    <tr
                      key={`sub-${i}`}
                      className="border-t border-[color:var(--rule-strong)] bg-[color:var(--paper-sink)]/50"
                    >
                      <td className="py-3 pr-4">
                        <span className="font-sans text-[length:var(--fs-eyebrow)] uppercase tracking-[0.12em] font-[550] text-[color:var(--accent)]">
                          {row.formula}
                        </span>
                      </td>
                      <td className="py-3 pr-4 text-[1.0625rem] font-[500] tracking-[-0.008em]">
                        {row.label}
                      </td>
                      <td className="py-3 pr-4 text-right text-[1.0625rem] font-[500] italic tabular-nums text-[color:var(--ink-mute)]">
                        —
                      </td>
                      <td className="py-3 pr-4 text-right text-[1.0625rem] font-[500] italic tabular-nums text-[color:var(--ink-mute)]">
                        —
                      </td>
                      <td className="py-3 pr-0 text-right italic tabular-nums text-[color:var(--ink-mute)]">
                        —
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr key={row.code} className="border-b border-[color:var(--rule)]">
                    <td className="py-3 pr-4">
                      <span
                        className={cn(
                          "inline-flex items-baseline gap-1.5 italic font-[500] tabular-nums",
                          row.sign === "−"
                            ? "text-[color:var(--negative)]"
                            : "text-[color:var(--positive)]",
                        )}
                      >
                        <span className="font-sans not-italic text-[length:var(--fs-body-sm)]">
                          {row.sign}
                        </span>
                        <span className="text-[1rem]">{row.code}</span>
                      </span>
                    </td>
                    <td className="py-3 pr-4 text-[1rem] font-[400] text-[color:var(--ink)]">
                      {row.label}
                    </td>
                    <td className="py-3 pr-4 text-right text-[1rem] italic tabular-nums text-[color:var(--ink-mute)]">
                      —
                    </td>
                    <td className="py-3 pr-4 text-right text-[1rem] italic tabular-nums text-[color:var(--ink-mute)]">
                      —
                    </td>
                    <td className="py-3 pr-0 text-right italic tabular-nums text-[color:var(--ink-mute)]">
                      —
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <p className="mt-4 font-sans text-[length:var(--fs-body-sm)] italic text-[color:var(--ink-mute)] max-w-prose">
            <span className="not-italic text-[length:var(--fs-eyebrow)] uppercase tracking-[0.12em] font-[550] text-[color:var(--ink-soft)] mr-2">
              Nota
            </span>
            Cálculo liberado após a revisão da distinção F × RV com o PO (R-02). Os lançamentos
            seguem sendo recebidos e conciliados normalmente — o que aguarda é o critério de
            agregação.
          </p>
        </div>
      </article>

      {/* Other reports */}
      <section className="flex flex-col gap-4 pt-10 border-t border-[color:var(--rule)]">
        <div className="flex items-baseline justify-between gap-4">
          <div className="flex flex-col gap-1">
            <Eyebrow>Próximos relatórios</Eyebrow>
            <h2 className="font-serif text-[length:var(--fs-section)] font-[500] leading-[1.1] tracking-[-0.012em]">
              Na fila editorial
            </h2>
          </div>
        </div>
        <Rule />
        <ul className="flex flex-col">
          {OTHER_REPORTS.map((name) => (
            <li
              key={name}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-6 py-3 border-b border-[color:var(--rule)] last:border-b-0"
            >
              <span className="font-serif text-[1.0625rem] font-[450] tracking-[-0.008em] text-[color:var(--ink)]">
                {name}
              </span>
              <span className="text-[length:var(--fs-eyebrow)] uppercase tracking-[0.12em] font-[550] italic text-[color:var(--ink-mute)]">
                em breve
              </span>
            </li>
          ))}
        </ul>
      </section>
    </AppLayout>
  );
}
