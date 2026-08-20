/**
 * The deterministic half. Extractions in, render context out — no model
 * involved, no arithmetic that isn't an integer sum of cents.
 *
 * Everything the client reads as a NUMBER is produced here. Everything they read
 * as PROSE comes from `{{ai}}`. The line between the two is this file.
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Contrato } from "../fields/contrato.ts";
import { contratoSchema } from "../fields/contrato.ts";
import type { Fatura } from "../fields/fatura.ts";
import { faturaSchema } from "../fields/fatura.ts";
import { dateKey, formatCents, monthLabel, parseEuroToCents, sumCents } from "./money.ts";
import { REPO_ROOT } from "./ai.ts";

export const EXTRACTIONS_DIR = resolve(REPO_ROOT, "poc", "out", "extractions");

export interface ExtractionEnvelope {
  readonly source_file: string;
  readonly provider: string;
  readonly document_type: string;
  readonly input_mode: string;
  readonly model: string;
  readonly data: unknown;
}

export interface LoadedExtractions {
  readonly faturas: readonly { readonly envelope: ExtractionEnvelope; readonly data: Fatura }[];
  readonly contrato: { readonly envelope: ExtractionEnvelope; readonly data: Contrato } | null;
}

export function loadExtractions(): LoadedExtractions {
  const files = readdirSync(EXTRACTIONS_DIR)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".invalid.json"))
    .sort();

  const faturas: { envelope: ExtractionEnvelope; data: Fatura }[] = [];
  let contrato: { envelope: ExtractionEnvelope; data: Contrato } | null = null;

  for (const file of files) {
    const envelope = JSON.parse(readFileSync(resolve(EXTRACTIONS_DIR, file), "utf8")) as ExtractionEnvelope;
    // Re-validate on read. A cache file is just a file; §12.4 says extraction
    // values are untrusted content, and that includes our own cache.
    if (envelope.document_type === "fatura") {
      faturas.push({ envelope, data: faturaSchema.parse(envelope.data) as Fatura });
    } else {
      contrato = { envelope, data: contratoSchema.parse(envelope.data) as Contrato };
    }
  }

  faturas.sort((a, b) => dateKey(a.data.data) - dateKey(b.data.data) || a.data.numero.localeCompare(b.data.numero));
  return { faturas, contrato };
}

/* ------------------------------------------------------------------ */

/** Service families, keyed on the invoice's own Ref.ª code. */
const FAMILIES: Record<string, { label: string; recurring: boolean }> = {
  FHS: { label: "Honorários de administração (House Sitting)", recurring: true },
  LIMP: { label: "Limpeza", recurring: true },
  LAV: { label: "Lavandaria", recurring: true },
  CONS: { label: "Instalação de serviços (água e eletricidade)", recurring: false },
};

function family(ref: string): { label: string; recurring: boolean } {
  return FAMILIES[ref] ?? { label: ref, recurring: false };
}

export interface Linha {
  readonly data: string;
  readonly numero: string;
  readonly ref: string;
  readonly familia: string;
  readonly descricao: string;
  readonly base_cents: number;
  readonly iva_cents: number;
  readonly total_cents: number;
  readonly extraordinario: boolean;
  readonly origem: string;
}

export interface Categoria {
  readonly familia: string;
  readonly quantidade: number;
  readonly base_cents: number;
  readonly total_cents: number;
  /** pt-BR display form, comma decimal: "73,6%" */
  readonly percentagem: string;
  /** CSS form, dot decimal: "73.6%". A comma decimal is an INVALID CSS length,
   *  so `width: 73,6%` is dropped and every bar silently renders full width.
   *  Same number, two grammars — the display locale is not the style sheet's. */
  readonly percentagem_css: string;
}

export interface Verificacao {
  readonly rotulo: string;
  readonly estado: string;
  readonly tom: "ok" | "atencao" | "info";
  readonly nota: string;
}

export interface Vencimento {
  readonly periodo: string;
  readonly vencimento: string;
  readonly valor_cents: number;
  readonly estado: string;
  readonly tom: "ok" | "atencao";
  readonly nota: string;
}

export interface ReportContext {
  readonly meta: {
    readonly titulo: string;
    readonly subtitulo: string;
    readonly periodo: string;
    readonly periodo_inicio: string;
    readonly periodo_fim: string;
    readonly emissao: string;
    readonly elaborado_por: string;
    /** every document behind the report — faturas + contrato */
    readonly n_documentos: number;
    /** just the faturas. The ledger footer must not claim to total the contract. */
    readonly n_faturas: number;
  };
  readonly identificacao: readonly { readonly rotulo: string; readonly valor: string }[];
  readonly linhas: readonly Linha[];
  readonly categorias: readonly Categoria[];
  readonly totais: {
    readonly base_cents: number;
    readonly iva_cents: number;
    readonly documento_cents: number;
    readonly recorrente_cents: number;
    readonly extraordinario_cents: number;
    readonly media_mensal_cents: number;
    readonly meses: number;
  };
  readonly reconciliacao: {
    readonly expressao: string;
    readonly confere: boolean;
    readonly nota: string;
  };
  readonly verificacoes: readonly Verificacao[];
  readonly vencimentos: readonly Vencimento[];
  readonly proveniencia: {
    readonly financeiro: string;
    readonly obrigacoes: string;
    readonly vencimentos: string;
    readonly notas: string;
  };
  /** §3.2 — `{{#if contrato}}`. Always PRESENT as a key, null when the role is unfilled. */
  readonly contrato: {
    readonly parte_segunda: string;
    readonly data_celebracao: string;
    readonly prazo: string;
    readonly denuncia_dias: number;
    /** verbatim from the contract — preserves the source typography, whatever it is */
    readonly retribuicao_verbatim: string;
    /** same amount as cents, so the report renders it in ONE house format */
    readonly retribuicao_cents: number;
    readonly retribuicao_periodicidade: string;
    readonly retribuicao_nota: string;
    readonly obrigacoes: readonly { readonly titulo: string; readonly detalhe: string }[];
  } | null;
}

/* ---- calendar stepping (dates only; never touches money) ---------- */

function toDate(ddmmyyyy: string): Date {
  const [d = "", m = "", y = ""] = ddmmyyyy.split("/");
  return new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
}

function fmt(date: Date): string {
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${String(date.getUTCFullYear())}`;
}

function addMonths(date: Date, months: number): Date {
  const next = new Date(date.getTime());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function monthsBetween(a: string, b: string): number {
  const from = toDate(a);
  const to = toDate(b);
  return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth()) + 1;
}

/* ------------------------------------------------------------------ */

export function buildContext(loaded: LoadedExtractions, emissao: string): ReportContext {
  const { faturas, contrato } = loaded;
  if (faturas.length === 0) throw new Error("papel obrigatório 'faturas' vazio — análise não pode correr (§3.2)");

  const first = faturas[0];
  const last = faturas[faturas.length - 1];
  if (first === undefined || last === undefined) throw new Error("acervo inconsistente");

  /* linhas — one per invoice line, money parsed verbatim -> cents */
  const linhas: Linha[] = [];
  for (const { data: f } of faturas) {
    for (const item of f.itens) {
      const base = parseEuroToCents(item.total);
      const fam = family(item.ref);
      // The line's own IVA is not printed per line; it is the document IVA when
      // the invoice has a single line, which is the case for every document in
      // this acervo. Guarded rather than assumed.
      const ivaDoc = parseEuroToCents(f.totais.iva);
      const iva = f.itens.length === 1 ? ivaDoc : Math.round((base * item.iva_pct) / 100);
      linhas.push({
        data: f.data,
        numero: f.numero,
        ref: item.ref,
        familia: fam.label,
        descricao: item.descricao,
        base_cents: base,
        iva_cents: iva,
        total_cents: base + iva,
        extraordinario: !fam.recurring,
        origem: `${f.numero} de ${f.data}`,
      });
    }
  }

  /* totals — integer sums of the extracted document totals */
  const base_cents = sumCents(faturas.map((f) => parseEuroToCents(f.data.totais.iliquido)));
  const iva_cents = sumCents(faturas.map((f) => parseEuroToCents(f.data.totais.iva)));
  const documento_cents = sumCents(faturas.map((f) => parseEuroToCents(f.data.totais.documento)));

  const extraordinario_cents = sumCents(linhas.filter((l) => l.extraordinario).map((l) => l.total_cents));
  const recorrente_cents = documento_cents - extraordinario_cents;
  const meses = monthsBetween(first.data.data, last.data.data);

  /* reconciliation — shown to the reader, not asserted behind their back */
  const confere = base_cents + iva_cents === documento_cents;
  const reconciliacao = {
    expressao: `${formatCents(base_cents)}  +  ${formatCents(iva_cents)}  =  ${formatCents(documento_cents)}`,
    confere,
    nota: confere
      ? `A soma das ${String(faturas.length)} bases tributáveis mais a soma do IVA iguala, ao cêntimo, a soma dos totais dos documentos.`
      : `Divergência de ${formatCents(base_cents + iva_cents - documento_cents)} entre a soma das parcelas e a soma dos totais — verificar.`,
  };

  /* categorias */
  const byFamily = new Map<string, { quantidade: number; base: number; total: number }>();
  for (const l of linhas) {
    const acc = byFamily.get(l.familia) ?? { quantidade: 0, base: 0, total: 0 };
    byFamily.set(l.familia, { quantidade: acc.quantidade + 1, base: acc.base + l.base_cents, total: acc.total + l.total_cents });
  }
  const categorias: Categoria[] = [...byFamily.entries()]
    .map(([familia, v]) => ({
      familia,
      quantidade: v.quantidade,
      base_cents: v.base,
      total_cents: v.total,
      percentagem: `${((v.total / documento_cents) * 100).toFixed(1).replace(".", ",")}%`,
      percentagem_css: `${((v.total / documento_cents) * 100).toFixed(1)}%`,
    }))
    .sort((a, b) => b.total_cents - a.total_cents);

  /* ---- contract-driven checks. Deterministic; no model opinion. ---- */
  const verificacoes: Verificacao[] = [];
  const vencimentos: Vencimento[] = [];

  const fhs = linhas.filter((l) => l.ref === "FHS");

  if (contrato) {
    const c = contrato.data;
    const retribCents = parseEuroToCents(c.retribuicao_valor);

    // 1. contractual honorarium: invoiced amount vs the clause
    const mismatched = fhs.filter((l) => l.base_cents !== retribCents);
    verificacoes.push({
      rotulo: "Honorários de administração",
      estado: mismatched.length === 0 ? "CONFORME" : "DIVERGENTE",
      tom: mismatched.length === 0 ? "ok" : "atencao",
      nota:
        mismatched.length === 0
          ? `As ${String(fhs.length)} faturas de House Sitting do período foram emitidas por ${formatCents(retribCents)}, exatamente o valor da retribuição ${c.retribuicao_periodicidade} prevista na cláusula Quarta.`
          : `${String(mismatched.length)} fatura(s) de House Sitting divergem do valor contratual de ${formatCents(retribCents)}.`,
    });

    // 2. semiannual anniversaries vs FHS invoices actually in the acervo
    const step = c.retribuicao_periodicidade.toLowerCase().startsWith("semestr") ? 6 : 12;
    const start = toDate(c.data_celebracao);
    const horizon = addMonths(toDate(last.data.data), step);
    for (let i = 0; ; i += 1) {
      const due = addMonths(start, i * step);
      if (due.getTime() > horizon.getTime()) break;
      const dueKey = dateKey(fmt(due));
      const match = fhs.find((l) => Math.abs(dateKey(l.data) - dueKey) < 100); // same month-ish
      // The period runs to the DAY BEFORE the next anniversary: 28/03 + 6 months
      // is 28/09, so the semester covered is 28/03 -> 27/09. Using `step - 1`
      // months instead lands on 28/08 and quietly shortens every period by a
      // month — checked against the invoice, which states the range in words.
      const coberto = fmt(addDays(addMonths(due, step), -1));
      vencimentos.push({
        periodo: `${fmt(due)} — ${coberto}`,
        vencimento: fmt(due),
        valor_cents: retribCents,
        estado: match ? "FATURADO" : "SEM FATURA NO ACERVO",
        tom: match ? "ok" : "atencao",
        nota: match
          ? `Coberto por ${match.origem}.`
          : "Nenhuma fatura de House Sitting no acervo cobre este período. Confirmar emissão junto da administradora.",
      });
    }
    const pendentes = vencimentos.filter((v) => v.tom === "atencao");
    verificacoes.push({
      rotulo: `Retribuição ${c.retribuicao_periodicidade}`,
      estado: pendentes.length === 0 ? "EM DIA" : "A CONFIRMAR",
      tom: pendentes.length === 0 ? "ok" : "atencao",
      nota:
        pendentes.length === 0
          ? "Todos os períodos semestrais decorridos desde a celebração têm fatura correspondente no acervo."
          : `${String(pendentes.length)} período(s) sem fatura correspondente no acervo — ver secção de próximos vencimentos.`,
    });

    // 3. IBAN on the invoices vs the IBAN in the payment clause
    const ibans = new Set(faturas.map((f) => f.data.iban));
    const divergente = !ibans.has(c.iban_pagamento);
    verificacoes.push({
      rotulo: "Dados de pagamento",
      estado: divergente ? "ATENÇÃO" : "CONFORME",
      tom: divergente ? "atencao" : "ok",
      nota: divergente
        ? `As faturas indicam IBAN terminado em ${[...ibans][0]?.slice(-6) ?? "?"} (${String(ibans.size)} distinto(s)), enquanto a cláusula Quarta do contrato designa a conta ${c.banco_pagamento} terminada em ${c.iban_pagamento.slice(-6)}. Confirmar a conta de destino antes de qualquer liquidação.`
        : "O IBAN das faturas coincide com a conta designada na cláusula Quarta do contrato.",
    });

    // 4. documents predating the contract
    const antes = faturas.filter((f) => dateKey(f.data.data) < dateKey(c.data_celebracao));
    verificacoes.push({
      rotulo: "Cobertura contratual",
      estado: antes.length === 0 ? "INTEGRAL" : "PARCIAL",
      tom: antes.length === 0 ? "ok" : "info",
      nota:
        antes.length === 0
          ? `Todas as ${String(faturas.length)} faturas do período são posteriores à celebração do contrato em ${c.data_celebracao}.`
          : `${String(antes.length)} fatura(s) — ${antes.map((f) => f.data.numero).join(", ")} — são anteriores à celebração do contrato em ${c.data_celebracao}, correspondendo a serviços prestados antes da vigência.`,
    });
  }

  // 5. always available, contract or not
  const extraLinhas = linhas.filter((l) => l.extraordinario);
  verificacoes.push({
    rotulo: "Itens extraordinários",
    estado: extraLinhas.length === 0 ? "SEM OCORRÊNCIAS" : `${String(extraLinhas.length)} ITEM(NS)`,
    tom: extraLinhas.length === 0 ? "ok" : "info",
    nota:
      extraLinhas.length === 0
        ? "Nenhum lançamento não recorrente no período."
        : `${extraLinhas.map((l) => `${l.familia} (${l.origem}, ${formatCents(l.total_cents)})`).join("; ")}. Não recorrente — não deve compor a base de comparação dos próximos períodos.`,
  });

  verificacoes.push({
    rotulo: "Integridade documental",
    estado: confere ? "VERIFICADA" : "DIVERGENTE",
    tom: confere ? "ok" : "atencao",
    nota: `${String(faturas.length)} documentos conferidos individualmente; base tributável e IVA reconciliam com o total faturado ao cêntimo.`,
  });

  /* identificação */
  const identificacao: { rotulo: string; valor: string }[] = [
    { rotulo: "Proprietário", valor: first.data.cliente_nome },
    { rotulo: "Contribuinte (NIF)", valor: first.data.contribuinte },
    { rotulo: "Cliente n.º", valor: first.data.cliente_numero },
    { rotulo: "Condição de pagamento", valor: first.data.cond_pagamento },
  ];
  if (contrato) {
    identificacao.splice(
      2,
      0,
      { rotulo: "Imóvel", valor: contrato.data.imovel_descricao },
      { rotulo: "Localização", valor: contrato.data.imovel_endereco },
      { rotulo: "Administradora", valor: `${contrato.data.parte_segunda} (NIF ${contrato.data.parte_segunda_nif})` },
    );
  }

  const proveniencia = {
    financeiro: `Extraído de ${String(faturas.length)} faturas de ${first.envelope.provider}: ${faturas.map((f) => f.data.numero).join(", ")}.`,
    obrigacoes: contrato
      ? `Extraído do ${contrato.data.titulo}, celebrado em ${contrato.data.data_celebracao} (cláusulas Segunda, Quarta e Sétima), confrontado com as faturas do período.`
      : "Papel «contrato» não preenchido — verificações limitadas ao acervo de faturas.",
    vencimentos: contrato
      ? `Calendário derivado da data de celebração (${contrato.data.data_celebracao}) e da periodicidade ${contrato.data.retribuicao_periodicidade} da cláusula Quarta.`
      : "Indisponível sem o contrato.",
    notas: `Redigido pela camada de análise sobre as ${String(faturas.length + (contrato ? 1 : 0))} extrações validadas; nenhum PDF foi relido nesta etapa.`,
  };

  return {
    meta: {
      titulo: "Relatório de Gestão Locatícia",
      subtitulo: "Resumo executivo de desempenho e obrigações contratuais",
      periodo: `${monthLabel(first.data.data)} — ${monthLabel(last.data.data)}`,
      periodo_inicio: first.data.data,
      periodo_fim: last.data.data,
      emissao,
      elaborado_por: "ReportFlow — Secretaria Executiva",
      n_documentos: faturas.length + (contrato ? 1 : 0),
      n_faturas: faturas.length,
    },
    identificacao,
    linhas,
    categorias,
    totais: {
      base_cents,
      iva_cents,
      documento_cents,
      recorrente_cents,
      extraordinario_cents,
      media_mensal_cents: Math.round(documento_cents / meses),
      meses,
    },
    reconciliacao,
    verificacoes,
    vencimentos,
    proveniencia,
    contrato: contrato
      ? {
          parte_segunda: contrato.data.parte_segunda,
          data_celebracao: contrato.data.data_celebracao,
          prazo: contrato.data.prazo,
          denuncia_dias: contrato.data.denuncia_dias,
          retribuicao_verbatim: contrato.data.retribuicao_valor,
          retribuicao_cents: parseEuroToCents(contrato.data.retribuicao_valor),
          retribuicao_periodicidade: contrato.data.retribuicao_periodicidade,
          retribuicao_nota: contrato.data.retribuicao_nota,
          obrigacoes: contrato.data.obrigacoes_principais.map((o) => ({ titulo: o.titulo, detalhe: o.detalhe })),
        }
      : null,
  };
}
