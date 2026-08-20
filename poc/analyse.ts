/**
 * Hop 2 — analysis. Prose only, never layout, never a number the reader trusts.
 *
 *   pnpm tsx poc/analyse.ts           # cached; use --force to regenerate
 *
 * §12.3, enforced rather than intended: this hop reads the stored extraction
 * JSON and the DERIVED TOTALS. It never opens a PDF. `documentPath` is not set
 * on the job, so there is no code path here that could.
 *
 * Why it is also given the derived totals: if the model had to add up thirteen
 * invoices itself, the prose could disagree with the table three inches above
 * it. It is handed the same integers `render.ts` prints, and told to reuse them
 * verbatim. Numbers stay deterministic; only the sentences are generated.
 *
 * §5.2 — regeneration must not eat human edits. Each slot carries `edited`;
 * an edited slot is preserved unless --force names it.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { FieldSpec } from "./fields/spec.ts";
import { fieldsToJsonSchema } from "./fields/spec.ts";
import { callWithRetry, costUsd, getAdapter, MODEL_ANALYSE, REPO_ROOT } from "./lib/ai.ts";
import { formatCents } from "./lib/money.ts";
import { buildContext, loadExtractions } from "./lib/report-model.ts";
import { ALL_SLOTS } from "./template/declaration.ts";

const ANALYSIS_PATH = resolve(REPO_ROOT, "poc", "out", "analysis.json");
export const EMISSAO = "20/08/2026";

const slotSchema = z.object(
  Object.fromEntries(
    ALL_SLOTS.map((s) => [
      s.slug,
      z
        .string()
        .min(40, `slot ${s.slug}: prosa curta demais`)
        .refine((t) => !/<[a-z/]/iu.test(t), `slot ${s.slug}: HTML não é permitido em prosa (§3.2 — prose only, never layout)`)
        .refine((t) => t.split(/\s+/u).length <= s.maxWords * 1.6, `slot ${s.slug}: excede o limite de palavras`),
    ]),
  ),
);

/** The slot declarations ARE the field list for this hop. Same mechanism (§3.1). */
const SLOT_FIELDS: FieldSpec[] = ALL_SLOTS.map((s) => ({
  name: s.slug,
  type: "string",
  required: true,
  description: `${s.guideline} Máximo ${String(s.maxWords)} palavras.`,
}));

interface AnalysisFile {
  readonly model: string;
  readonly generated_at: string;
  readonly slots: Record<string, { text: string; edited: boolean }>;
}

export function readAnalysis(): AnalysisFile | null {
  if (!existsSync(ANALYSIS_PATH)) return null;
  return JSON.parse(readFileSync(ANALYSIS_PATH, "utf8")) as AnalysisFile;
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const existing = readAnalysis();
  if (existing && !force) {
    console.log(`Análise em cache (${existing.model}). Use --force para regerar.`);
    return;
  }

  const adapter = getAdapter();
  if (adapter === null) {
    console.error("Nenhuma chave de provider encontrada (GOOGLE_API_KEY).");
    process.exitCode = 1;
    return;
  }

  const loaded = loadExtractions();
  const ctx = buildContext(loaded, EMISSAO);

  // Grounding pack: the extractions themselves + the numbers already computed
  // deterministically, so the prose cannot drift from the table.
  const factos = {
    periodo: ctx.meta.periodo,
    numero_de_faturas: loaded.faturas.length,
    total_faturado: formatCents(ctx.totais.documento_cents),
    base_tributavel: formatCents(ctx.totais.base_cents),
    iva_total: formatCents(ctx.totais.iva_cents),
    servicos_recorrentes: formatCents(ctx.totais.recorrente_cents),
    itens_extraordinarios: formatCents(ctx.totais.extraordinario_cents),
    media_mensal: formatCents(ctx.totais.media_mensal_cents),
    composicao: ctx.categorias.map((c) => `${c.familia}: ${String(c.quantidade)} doc(s), ${formatCents(c.total_cents)} (${c.percentagem})`),
    verificacoes: ctx.verificacoes.map((v) => `${v.rotulo} — ${v.estado}: ${v.nota}`),
    proximos_vencimentos: ctx.vencimentos.map((v) => `${v.vencimento} (${v.periodo}) — ${v.estado}: ${v.nota}`),
    contrato: ctx.contrato,
    faturas: loaded.faturas.map((f) => f.data),
  };

  const prompt = [
    "Você redige as secções em prosa de um relatório de gestão locatícia destinado ao proprietário do imóvel.",
    "",
    "FACTOS APURADOS (já validados e já somados — use estes números EXATAMENTE como aparecem, não recalcule nada):",
    JSON.stringify(factos, null, 2),
    "",
    "Escreva os campos pedidos. Restrições absolutas:",
    "- Nenhum número que não conste dos factos acima.",
    "- Nenhuma data que não conste dos factos acima.",
    "- Nenhuma projeção, estimativa ou cenário.",
    "- Texto corrido, sem HTML, sem marcadores, sem títulos.",
    "- Português do Brasil, registo formal.",
  ].join("\n");

  console.log(`Análise — ${adapter.provider}/${MODEL_ANALYSE} · ${String(loaded.faturas.length)} extrações + ${loaded.contrato ? "1 contrato" : "sem contrato"}`);
  console.log("(§12.3 — nenhum PDF é lido nesta etapa)\n");

  const result = await callWithRetry(
    adapter,
    {
      system: "Você é uma secretária executiva. Escreve com sobriedade, precisão e sem adjetivação comercial. Nunca inventa números.",
      prompt,
      // NO documentPath. That is the §12.3 guarantee, expressed as an absence.
      schema: fieldsToJsonSchema(SLOT_FIELDS),
      schemaName: "analise_slots",
      maxTokens: 4096,
    },
    MODEL_ANALYSE,
  );

  const parsed = slotSchema.safeParse(JSON.parse(result.text));
  if (!parsed.success) {
    console.error("Análise rejeitada pela validação por slot:");
    for (const issue of parsed.error.issues) console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    process.exitCode = 1;
    return;
  }

  const slots: Record<string, { text: string; edited: boolean }> = {};
  for (const [slug, text] of Object.entries(parsed.data)) {
    // §5.2 — an edited slot survives regeneration.
    const previous = existing?.slots[slug];
    if (previous?.edited === true && !process.argv.includes(`--force=${slug}`)) {
      console.log(`  = ${slug} — editado por humano, preservado (§5.2)`);
      slots[slug] = previous;
      continue;
    }
    slots[slug] = { text, edited: false };
    console.log(`  ✓ ${slug} — ${String(text.split(/\s+/u).length)} palavras`);
  }

  writeFileSync(
    ANALYSIS_PATH,
    `${JSON.stringify({ model: result.model, ai_provider: result.provider, generated_at: new Date().toISOString(), usage: result.usage, slots }, null, 2)}\n`,
  );

  console.log(`\nAnálise gravada · $${costUsd(result.model, result.usage).toFixed(4)}`);
}

await main();
