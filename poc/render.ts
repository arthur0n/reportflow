/**
 * Render — deterministic substitution. Extraction values + AI slots -> HTML.
 *
 *   pnpm tsx poc/render.ts
 *
 * The claim this file has to earn: a number in the HTML is byte-identical to the
 * number on the invoice. Not "close", not "correctly rounded" — the same bytes.
 * The assertions at the bottom check that against the extraction JSON and fail
 * the build if it ever stops being true.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderTemplate, type AiSlots } from "./lib/handlebars.ts";
import { formatCents, parseEuroToCents, sumCents } from "./lib/money.ts";
import { buildContext, loadExtractions, type ReportContext } from "./lib/report-model.ts";
import { REPO_ROOT } from "./lib/ai.ts";
import { TEMPLATE_FIEL, TEMPLATE_MELHORADO, type OutboundTemplate } from "./template/declaration.ts";

const TEMPLATE_DIR = resolve(REPO_ROOT, "poc", "template");
const OUT_DIR = resolve(REPO_ROOT, "poc", "out");
const ANALYSIS_PATH = resolve(OUT_DIR, "analysis.json");
const EMISSAO = "20/08/2026";

/** Placeholder prose so the layout is reviewable before hop 2 has ever run. */
const PLACEHOLDER = (slug: string): string =>
  `[slot "${slug}" ainda não gerado — execute "pnpm tsx poc/analyse.ts" para preencher esta secção com prosa fundamentada nas extrações.]`;

function loadSlots(): { slots: AiSlots; source: string } {
  if (!existsSync(ANALYSIS_PATH)) {
    return {
      slots: { notas_executivas: PLACEHOLDER("notas_executivas"), acompanhamento: PLACEHOLDER("acompanhamento") },
      source: "placeholder (análise ainda não executada)",
    };
  }
  const file = JSON.parse(readFileSync(ANALYSIS_PATH, "utf8")) as {
    model: string;
    slots: Record<string, { text: string }>;
  };
  const slots: Record<string, string> = {};
  for (const [slug, v] of Object.entries(file.slots)) slots[slug] = v.text;
  return { slots, source: file.model };
}

/**
 * §3.2 — every DECLARED role must exist as a key in the context, even when
 * unfilled, so `{{#if contrato}}` can branch on it under Handlebars strict mode
 * instead of throwing. An unfilled REQUIRED role blocks the render outright,
 * which is what makes "aguardando: contrato" a showable state.
 */
function assertRolesFilled(template: OutboundTemplate, ctx: ReportContext): void {
  for (const role of template.roles) {
    const filled = role.key === "faturas" ? ctx.linhas.length > 0 : ctx.contrato !== null;
    if (role.required && !filled) {
      throw new Error(`papel obrigatório não preenchido: "${role.key}" (${role.provider} / ${role.documentType}) — aguardando documento`);
    }
    if (!filled) console.log(`  · papel opcional vazio: ${role.key} — secções dependentes serão omitidas`);
  }
}

function render(template: OutboundTemplate, ctx: ReportContext, slots: AiSlots, outFile: string): string {
  assertRolesFilled(template, ctx);
  const source = readFileSync(resolve(TEMPLATE_DIR, template.file), "utf8");
  const html = renderTemplate(source, ctx as unknown as Record<string, unknown>, { slots });
  writeFileSync(resolve(OUT_DIR, outFile), html);
  return html;
}

/* ------------------------------------------------------------------ */
/* The assertions. These are the POC's actual claim.                   */
/* ------------------------------------------------------------------ */

let checks = 0;
function assertContains(html: string, needle: string, label: string): void {
  if (!html.includes(needle)) throw new Error(`ASSERÇÃO FALHOU [${label}]: "${needle}" ausente do HTML renderizado`);
  checks += 1;
}

function main(): void {
  const loaded = loadExtractions();
  const ctx = buildContext(loaded, EMISSAO);
  const { slots, source } = loadSlots();

  console.log(`Render — ${String(loaded.faturas.length)} faturas, contrato ${loaded.contrato ? "presente" : "ausente"}`);
  console.log(`Prosa: ${source}\n`);

  const fiel = render(TEMPLATE_FIEL, ctx, slots, "relatorio-fiel.html");
  console.log("  ✓ poc/out/relatorio-fiel.html");
  const melhorado = render(TEMPLATE_MELHORADO, ctx, slots, "relatorio-melhorado.html");
  console.log("  ✓ poc/out/relatorio-melhorado.html\n");

  console.log("Verificação de identidade byte-a-byte (extração -> HTML):");

  /* 1. Every single invoice's document total appears verbatim in both files. */
  for (const { data: f } of loaded.faturas) {
    const verbatim = f.totais.documento.trim();
    const roundTripped = formatCents(parseEuroToCents(verbatim));
    if (roundTripped !== verbatim) {
      throw new Error(`ASSERÇÃO FALHOU: round-trip de ${f.numero} alterou o valor: "${verbatim}" -> "${roundTripped}"`);
    }
    assertContains(fiel, verbatim, `${f.numero} total no relatório fiel`);
    assertContains(melhorado, verbatim, `${f.numero} total no relatório melhorado`);
  }
  console.log(`  ✓ ${String(loaded.faturas.length)} totais de documento presentes VERBATIM em ambos os relatórios`);

  /* 2. The grand total is the integer sum of the extracted totals — and the
        report's own reconciliation identity holds. */
  const somaDocumentos = sumCents(loaded.faturas.map((f) => parseEuroToCents(f.data.totais.documento)));
  const somaBases = sumCents(loaded.faturas.map((f) => parseEuroToCents(f.data.totais.iliquido)));
  const somaIva = sumCents(loaded.faturas.map((f) => parseEuroToCents(f.data.totais.iva)));
  if (somaBases + somaIva !== somaDocumentos) {
    throw new Error(`ASSERÇÃO FALHOU: base (${formatCents(somaBases)}) + IVA (${formatCents(somaIva)}) != total (${formatCents(somaDocumentos)})`);
  }
  if (ctx.totais.documento_cents !== somaDocumentos) throw new Error("ASSERÇÃO FALHOU: total do contexto diverge da soma das extrações");
  assertContains(fiel, formatCents(somaDocumentos), "total geral (fiel)");
  assertContains(melhorado, formatCents(somaDocumentos), "total geral (melhorado)");
  console.log(`  ✓ ${formatCents(somaBases)} + ${formatCents(somaIva)} = ${formatCents(somaDocumentos)} — reconciliação em cêntimos inteiros`);

  /* 3. The contractual honorarium reaches the page as the SAME AMOUNT.
        Note this one is value-parity, not byte-parity, and deliberately so: the
        contract spells the currency out and separates thousands with a space,
        while the invoices use a dot and the € sign — two typographies for one
        number. The report picks one house format, and the
        check that matters is that the contract clause and the House Sitting
        invoices agree to the cent — which is the whole reconciliation. */
  if (loaded.contrato) {
    const verbatim = loaded.contrato.data.retribuicao_valor.trim();
    const cents = parseEuroToCents(verbatim);
    assertContains(melhorado, formatCents(cents), "retribuição contratual (melhorado)");
    assertContains(fiel, formatCents(cents), "retribuição contratual (fiel)");

    const fhs = loaded.faturas.filter((f) => f.data.itens.some((i) => i.ref === "FHS"));
    for (const f of fhs) {
      const facturado = parseEuroToCents(f.data.totais.iliquido);
      if (facturado !== cents) {
        throw new Error(`ASSERÇÃO FALHOU: ${f.data.numero} facturou ${formatCents(facturado)}, contrato prevê ${formatCents(cents)}`);
      }
      checks += 1;
    }
    console.log(`  ✓ retribuição contratual "${verbatim}" = ${formatCents(cents)} = base de ${String(fhs.length)} fatura(s) House Sitting`);
  }

  /* 4. Nothing the field list never asked for leaked in.
        Page 1 of the contract also carries a passport number, a CPF and the
        spouse's NIF. The field list never extracts them, so they cannot reach
        the page — but "cannot" is worth checking rather than assuming.

        Checked by SHAPE, not by value: hardcoding the client's actual passport
        and CPF here would put the very identifiers this test exists to keep out
        of the report into a committed source file. The patterns generalise to
        the next client too, which a literal denylist never would. */
  const padroesPii: readonly { readonly nome: string; readonly re: RegExp }[] = [
    { nome: "CPF", re: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/u },
    { nome: "passaporte", re: /\b[A-Z]{2}\d{6}\b/u },
    { nome: "menção a passaporte", re: /passaporte/iu },
    { nome: "RG", re: /\bRG:?\s*\d{2}\.\d{3}\.\d{3}-\d\b/u },
  ];
  for (const { nome, re } of padroesPii) {
    for (const [alvo, html] of [
      ["fiel", fiel],
      ["melhorado", melhorado],
    ] as const) {
      const hit = re.exec(html);
      if (hit) throw new Error(`ASSERÇÃO FALHOU: ${nome} vazou para o relatório ${alvo} (padrão ${re.source})`);
    }
    checks += 1;
  }
  console.log(`  ✓ nenhum dado pessoal fora do necessário (${String(padroesPii.length)} padrões verificados)`);

  /* 5. Escaping is really on. */
  if (/<script/iu.test(fiel.replace(/<style[\s\S]*?<\/style>/giu, ""))) throw new Error("ASSERÇÃO FALHOU: <script> no output");
  checks += 1;

  console.log(`\n${String(checks)} asserções passaram.`);
  console.log("Abra os ficheiros no Chrome e use Imprimir → Salvar como PDF (A4, sem cabeçalhos/rodapés).");
}

main();
