/**
 * Hop 3 — adversarial verify (§12.13). Runs after extraction and after
 * analysis; never rewrites either.
 *
 *   pnpm tsx poc/verify.ts               # all 13 faturas + 1 contrato + analysis
 *   pnpm tsx poc/verify.ts FT_C2025_141.pdf
 *   pnpm tsx poc/verify.ts --no-analysis # extraction verify only
 *   pnpm tsx poc/verify.ts --no-extractions
 *
 * Two adversarial checks, same policy in both:
 *
 *  1. EXTRACTION VERIFY — the source PDF + the cached extraction JSON go to
 *     MODEL_VERIFY with a refute-this prompt: try to find a field whose value
 *     does not match exactly what the document shows. Each field gets a
 *     verdict: `confirmado` | `refutado` | `ilegivel`.
 *  2. ANALYSIS VERIFY — the `{{ai}}` slot texts from `poc/out/analysis.json`
 *     go to MODEL_VERIFY alongside the raw extraction DATA (never a PDF, same
 *     §12.3 guarantee hop 2 already gives) with a refute-this prompt for every
 *     factual claim: numbers, dates, document counts, IBAN references, causal
 *     or conformity claims.
 *
 * The verifier is a DIFFERENT model than the extractor/analyst
 * (`MODEL_EXTRACT` / `MODEL_ANALYSE` are both gemini-3.5-flash-family;
 * `MODEL_VERIFY` is gemini-3.5-pro's nearest REAL model, `gemini-3.1-pro-
 * preview` — see the comment on that constant in `lib/ai.ts`, including why
 * `gemini-3.5-pro` does not exist). Only a Google key exists today, so this
 * is a different tier/generation rather than cross-provider; the registry
 * already supports a second provider the day a second key exists, and
 * swapping `MODEL_VERIFY` is the entire migration.
 *
 * The extraction verifier is handed the SAME frozen field list the extractor
 * was calibrated against (§3.1 — "one source, many consumers", extended to
 * this hop). That is not a leash on the adversary: several fields are
 * explicitly specified as normalized or paraphrased rather than verbatim
 * (dates always dd/mm/aaaa regardless of how the document prints them, an
 * IBAN with spaces stripped, a multi-line PDF cell condensed to one string, a
 * contract obligation summarized as a short title + one-sentence paraphrase).
 * A verifier that does not know this treats every one of those MANDATED
 * transformations as a "discrepancy" and drowns the real signal in noise —
 * that happened on the first live pass here (see `poc/README.md`).
 *
 * Policy (§12.13, mirrored from §3/§4.2 in reverse): the verifier NEVER
 * rewrites a value. A `refutado` verdict is a flag for a human, not a
 * correction — `valor_documento` / `fundamento` records what the verifier
 * SAW, and the original extraction/analysis file is untouched. Any
 * `refutado` anywhere -> this script exits non-zero and prints exactly which
 * fields/claims would go to `revisar`.
 *
 * Idempotent by construction, same as `extract.ts`: one verdict file per
 * source, `poc/out/verify/<file>.verdict.json`; an existing file is SKIPPED,
 * not re-checked. Re-running this script after a clean pass costs $0.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { z } from "zod";
import type { AiJob } from "./lib/providers/types.ts";
import { PermanentError } from "./lib/providers/types.ts";
import type { AiAdapter } from "./lib/ai.ts";
import { costUsd, getAdapter, MODEL_VERIFY, REPO_ROOT } from "./lib/ai.ts";
import { EXTRACTIONS_DIR, loadExtractions } from "./lib/report-model.ts";
import { CONTRATO_TEMPLATE } from "./fields/contrato.ts";
import { FATURA_TEMPLATE } from "./fields/fatura.ts";
import { fieldsToPrompt } from "./fields/spec.ts";

const PDF_DIR = resolve(REPO_ROOT, "pdf");
const VERIFY_DIR = resolve(REPO_ROOT, "poc", "out", "verify");
const ANALYSIS_PATH = resolve(REPO_ROOT, "poc", "out", "analysis.json");
const SUMMARY_PATH = resolve(VERIFY_DIR, "SUMMARY.md");

/**
 * A soft spend cap, not a cache mechanism (that is `existsSync(outPath)`
 * below — the actual billing guard, same as `extract.ts`). This is the
 * "keep spend under ~$2" instruction expressed as code rather than trust:
 * once the running total would clear it, no NEW call is issued. Already
 * cached verdicts still count as free and are still reported.
 */
const BUDGET_USD = 2.0;

const VERDICTS = ["confirmado", "refutado", "ilegivel"] as const;
type Verdict = (typeof VERDICTS)[number];

const fieldVerdictSchema = z
  .object({
    field: z.string().min(1),
    verdict: z.enum(VERDICTS),
    /** Only when verdict === "refutado" — the extractor never gets rewritten,
     * this just records what the document actually shows. */
    valor_documento: z.string().nullable(),
  })
  .strict();

const claimVerdictSchema = z
  .object({
    slot: z.string().min(1),
    claim: z.string().min(1),
    verdict: z.enum(VERDICTS),
    /** Only when verdict !== "confirmado". */
    fundamento: z.string().nullable(),
  })
  .strict();

const extractionVerdictsSchema = z.array(fieldVerdictSchema).min(1);
const analysisVerdictsSchema = z.array(claimVerdictSchema).min(1);

/** Provider-neutral JSON Schema for the array-of-verdicts response. Not built
 * from `fields/spec.ts` — that machinery assumes an object-shaped extraction
 * template; this is a fixed audit shape, so it is written out directly. */
function verdictArraySchema(itemProps: Record<string, unknown>, required: readonly string[]): Record<string, unknown> {
  return {
    type: "array",
    items: {
      type: "object",
      properties: itemProps,
      required,
      additionalProperties: false,
    },
  };
}

const FIELD_VERDICT_JSON_SCHEMA = verdictArraySchema(
  {
    field: {
      type: "string",
      description: "Caminho do campo tal como no JSON de extração, ex.: totais.iliquido ou itens[0].preco.",
    },
    verdict: {
      type: "string",
      enum: VERDICTS,
      description:
        "confirmado = o documento mostra exatamente este valor; refutado = o documento mostra outra coisa; ilegivel = o documento não permite confirmar nem refutar.",
    },
    valor_documento: {
      type: ["string", "null"],
      description: "O que o documento REALMENTE mostra — preencha SOMENTE quando verdict=refutado; caso contrário null.",
    },
  },
  ["field", "verdict", "valor_documento"],
);

const CLAIM_VERDICT_JSON_SCHEMA = verdictArraySchema(
  {
    slot: { type: "string", description: "O slug do slot de prosa a que a afirmação pertence." },
    claim: { type: "string", description: "A afirmação factual isolada, tal como aparece (ou parafraseada de forma mínima)." },
    verdict: {
      type: "string",
      enum: VERDICTS,
      description:
        "confirmado = sustentado exatamente pelos dados de extração; refutado = contradito ou não sustentado pelos dados; ilegivel = não é possível verificar com os dados dados.",
    },
    fundamento: {
      type: ["string", "null"],
      description: "Por que a afirmação não está sustentada — preencha SOMENTE quando verdict != confirmado; caso contrário null.",
    },
  },
  ["slot", "claim", "verdict", "fundamento"],
);

/* ------------------------------------------------------------------ */
/* One retry, per §12.13's operating instructions — NOT `callWithRetry`     */
/* (extract.ts/analyse.ts share that one at up to 3 retries; this hop is    */
/* deliberately more conservative about spend, so it gets its own).         */
/* ------------------------------------------------------------------ */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendWithOneRetry(adapter: AiAdapter, job: AiJob, model: string) {
  try {
    return await adapter.send(job, model);
  } catch (error) {
    if (error instanceof PermanentError) throw error;
    const reason = error instanceof Error ? error.message.slice(0, 120) : String(error);
    console.warn(`  ! falha transitória (${reason}) — 1 nova tentativa`);
    await sleep(2000);
    return adapter.send(job, model);
  }
}

/* ------------------------------------------------------------------ */

interface ExtractionVerdictFile {
  readonly kind: "extraction";
  readonly source_file: string;
  readonly extraction_file: string;
  readonly document_type: string;
  readonly model: string;
  readonly ai_provider: string;
  readonly verified_at: string;
  readonly usage: { input_tokens: number; output_tokens: number };
  readonly verdicts: readonly { field: string; verdict: Verdict; valor_documento: string | null }[];
}

interface AnalysisVerdictFile {
  readonly kind: "analysis";
  readonly model: string;
  readonly ai_provider: string;
  readonly verified_at: string;
  readonly usage: { input_tokens: number; output_tokens: number };
  readonly verdicts: readonly { slot: string; claim: string; verdict: Verdict; fundamento: string | null }[];
}

function cacheKeyFor(sourceFile: string): string {
  return `${basename(sourceFile, ".pdf")}.verdict.json`;
}

const SYSTEM_EXTRACTION = [
  "Você é um auditor adversarial independente. Os dados abaixo foram extraídos de um documento por OUTRO modelo (o extrator), seguindo a especificação de campos fornecida.",
  "O seu papel não é confirmar a extração — é tentar REFUTÁ-LA. Presuma que ela pode conter erros e procure-os ativamente:",
  "um dígito trocado, uma data incorreta, um valor arredondado ou mal transcrito, um nome truncado, um IBAN parcialmente errado, um campo copiado do exemplar errado, uma obrigação inventada ou omitida, uma paráfrase que muda o SENTIDO da cláusula original.",
  "Compare cada campo, um a um, com o documento PDF anexado E com o que a especificação de campos (abaixo) pediu para aquele campo.",
  "IMPORTANTE — a especificação de campos pede explicitamente certas NORMALIZAÇÕES: datas sempre em dd/mm/aaaa (não importa como o documento as imprime), um IBAN sem espaços, o texto de uma célula que se estende por várias linhas do documento condensado numa só string, um resumo, uma paráfrase ou um rótulo curto em vez de uma citação literal. Quando a descrição do campo pede isso, aplicar essa transformação é o comportamento CORRETO — NÃO é uma refutação. Quebras de linha dentro de uma célula ou parágrafo do documento nunca são, por si só, uma diferença de conteúdo: normalize espaços em branco antes de comparar.",
  "Refute apenas quando o CONTEÚDO factual diverge do documento — um valor diferente, uma data diferente, uma cláusula com sentido diferente, uma obrigação inventada ou omitida — não quando apenas a formatação, a pontuação ou a extensão do texto mudam de acordo com o que a especificação pediu.",
  "Regras invioláveis:",
  "1. Nunca corrija o valor você mesmo. Se encontrar uma discrepância real de conteúdo, relate em valor_documento o que o documento REALMENTE mostra, de forma concisa (uma frase; não é preciso citar o parágrafo inteiro).",
  '2. verdict="confirmado" quando o CONTEÚDO bate com o documento, incluindo quando a especificação do campo pediu uma normalização/resumo/paráfrase e a extração cumpriu essa instrução fielmente.',
  '3. verdict="refutado" quando o CONTEÚDO diverge do documento, para além do que a especificação do campo permite.',
  '4. verdict="ilegivel" quando o documento não permite confirmar nem refutar (zona ilegível, página em falta, campo cortado).',
  "5. Não omita nenhum campo: percorra o JSON campo a campo, incluindo cada elemento de cada array (use notação de caminho: itens[0].total, obrigacoes_principais[2].detalhe, etc.).",
].join("\n");

const SYSTEM_ANALYSIS = [
  "Você é um auditor adversarial independente. O texto abaixo foi escrito por OUTRO modelo (o redator) a partir dos dados de extração fornecidos.",
  "O seu papel não é elogiar a prosa — é tentar REFUTAR cada afirmação factual nela contida, comparando-a com os dados de extração anexados (nenhum PDF foi fornecido nesta etapa; os dados de extração são a ÚNICA fonte permitida).",
  "Decomponha cada slot em afirmações factuais discretas — cada número, cada data, cada contagem de documentos, cada referência a IBAN, e cada afirmação causal ou de conformidade (ex.: \"em conformidade exata com\", \"distinto de\", \"anterior a\") é UMA afirmação a avaliar separadamente.",
  "Regras invioláveis:",
  "1. Nunca reescreva o texto. Relate apenas o veredito e, quando necessário, o fundamento.",
  '2. verdict="confirmado" apenas se TODO número/data/contagem/referência na afirmação estiver sustentado, exatamente, pelos dados fornecidos.',
  '3. verdict="refutado" se a afirmação contradiz os dados ou não pode ser reconstruída a partir deles (um número que não aparece em lado nenhum, uma soma errada, uma contagem errada, uma comparação incorreta).',
  '4. verdict="ilegivel" apenas se os dados fornecidos forem literalmente insuficientes para decidir (raro — a maior parte das afirmações é verificável).',
  "5. Cubra pelo menos: todo número monetário, toda data, toda contagem de documentos, toda referência a IBAN, e toda afirmação causal ou de conformidade em cada slot.",
  "6. `fundamento` deve ser conciso (uma frase); não é preciso citar os dados inteiros.",
].join("\n");

async function verifyExtraction(
  adapter: AiAdapter,
  extractionFile: string,
  budget: { spent: number },
): Promise<{ usd: number; verdicts: ExtractionVerdictFile["verdicts"] } | "skipped" | "over-budget"> {
  const envelope = JSON.parse(readFileSync(resolve(EXTRACTIONS_DIR, extractionFile), "utf8")) as {
    source_file: string;
    document_type: string;
    data: unknown;
  };
  const outPath = resolve(VERIFY_DIR, cacheKeyFor(envelope.source_file));

  if (existsSync(outPath)) {
    console.log(`  = ${envelope.source_file} — já verificado (cache), a saltar`);
    return "skipped";
  }

  if (budget.spent >= BUDGET_USD) {
    console.warn(`  ! ${envelope.source_file} — orçamento (~$${BUDGET_USD.toFixed(2)}) atingido, a saltar (sem chamada)`);
    return "over-budget";
  }

  const template = envelope.document_type === "fatura" ? FATURA_TEMPLATE : CONTRATO_TEMPLATE;

  const prompt = [
    `Documento fonte anexado (PDF). Tipo: ${envelope.document_type} / ${template.provider}.`,
    "",
    "Especificação de campos que o extrator recebeu (o que cada campo DEVE conter, incluindo normalizações/resumos pedidos):",
    fieldsToPrompt(template.fields),
    "",
    "Dados extraídos por OUTRO modelo, que você deve tentar refutar:",
    JSON.stringify(envelope.data, null, 2),
    "",
    envelope.document_type === "fatura"
      ? "Nota: este PDF contém a MESMA fatura repetida em três exemplares (Original, Duplicado, Triplicado). Confirme contra o exemplar Original."
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  console.log(`  → ${envelope.source_file} (verify, ${adapter.provider}/${MODEL_VERIFY})`);

  const result = await sendWithOneRetry(
    adapter,
    {
      system: SYSTEM_EXTRACTION,
      prompt,
      documentPath: resolve(PDF_DIR, envelope.source_file),
      schema: FIELD_VERDICT_JSON_SCHEMA,
      schemaName: "verificacao_campos",
      // Generous headroom: gemini-3.1-pro-preview's thinking tokens are
      // billed at the output rate and share this budget (same accounting
      // gemini.ts already applies) — 8192 truncated the contract's response
      // into invalid JSON on the first live pass (12 obligations x 3 fields).
      maxTokens: 32768,
    },
    MODEL_VERIFY,
  );

  const usd = costUsd(result.model, result.usage);

  let payload: unknown;
  try {
    payload = JSON.parse(result.text) as unknown;
  } catch {
    payload = { __unparseable: result.text };
  }
  const parsed = extractionVerdictsSchema.safeParse(payload);

  if (!parsed.success) {
    const invalidPath = outPath.replace(/\.json$/u, ".invalid.json");
    writeFileSync(invalidPath, `${JSON.stringify({ raw: payload, issues: parsed.error.issues }, null, 2)}\n`);
    console.error(`  ✗ ${envelope.source_file} — resposta do verificador inválida, guardada em ${basename(invalidPath)} · $${usd.toFixed(4)} gasto mesmo assim`);
    return { usd, verdicts: [] };
  }

  const file: ExtractionVerdictFile = {
    kind: "extraction",
    source_file: envelope.source_file,
    extraction_file: extractionFile,
    document_type: envelope.document_type,
    model: result.model,
    ai_provider: result.provider,
    verified_at: new Date().toISOString(),
    usage: result.usage,
    verdicts: parsed.data,
  };
  writeFileSync(outPath, `${JSON.stringify(file, null, 2)}\n`);

  const refuted = parsed.data.filter((v) => v.verdict === "refutado").length;
  const illegible = parsed.data.filter((v) => v.verdict === "ilegivel").length;
  console.log(
    `  ✓ ${envelope.source_file} — ${String(parsed.data.length)} campos: ${String(parsed.data.length - refuted - illegible)} confirmado(s), ${String(refuted)} refutado(s), ${String(illegible)} ilegível(eis) · $${usd.toFixed(4)}`,
  );
  return { usd, verdicts: parsed.data };
}

async function verifyAnalysis(adapter: AiAdapter, budget: { spent: number }): Promise<{ usd: number } | "skipped" | "missing" | "over-budget"> {
  const outPath = resolve(VERIFY_DIR, "analysis.verdict.json");
  if (existsSync(outPath)) {
    console.log("  = análise — já verificada (cache), a saltar");
    return "skipped";
  }
  if (!existsSync(ANALYSIS_PATH)) {
    console.warn("  ! poc/out/analysis.json não existe — corra poc/analyse.ts primeiro");
    return "missing";
  }
  if (budget.spent >= BUDGET_USD) {
    console.warn(`  ! análise — orçamento (~$${BUDGET_USD.toFixed(2)}) atingido, a saltar (sem chamada)`);
    return "over-budget";
  }

  const analysis = JSON.parse(readFileSync(ANALYSIS_PATH, "utf8")) as {
    model: string;
    slots: Record<string, { text: string; edited: boolean }>;
  };

  // §12.3's guarantee, held a second time: extraction DATA only, never a PDF.
  const loaded = loadExtractions();
  const dados = {
    faturas: loaded.faturas.map((f) => f.data),
    contrato: loaded.contrato?.data ?? null,
  };
  const textos = Object.fromEntries(Object.entries(analysis.slots).map(([slug, s]) => [slug, s.text]));

  const prompt = [
    "DADOS DE EXTRAÇÃO (a única fonte permitida — nenhum PDF foi fornecido nesta etapa):",
    JSON.stringify(dados, null, 2),
    "",
    "TEXTO A AUDITAR, por slot:",
    JSON.stringify(textos, null, 2),
  ].join("\n");

  console.log(`  → análise (verify, ${adapter.provider}/${MODEL_VERIFY}, ${String(Object.keys(textos).length)} slot(s))`);

  const result = await sendWithOneRetry(
    adapter,
    {
      system: SYSTEM_ANALYSIS,
      prompt,
      // NO documentPath — same absence-as-guarantee as analyse.ts itself.
      schema: CLAIM_VERDICT_JSON_SCHEMA,
      schemaName: "verificacao_afirmacoes",
      maxTokens: 16384,
    },
    MODEL_VERIFY,
  );

  const usd = costUsd(result.model, result.usage);

  let payload: unknown;
  try {
    payload = JSON.parse(result.text) as unknown;
  } catch {
    payload = { __unparseable: result.text };
  }
  const parsed = analysisVerdictsSchema.safeParse(payload);

  if (!parsed.success) {
    const invalidPath = outPath.replace(/\.json$/u, ".invalid.json");
    writeFileSync(invalidPath, `${JSON.stringify({ raw: payload, issues: parsed.error.issues }, null, 2)}\n`);
    console.error(`  ✗ análise — resposta do verificador inválida, guardada em ${basename(invalidPath)} · $${usd.toFixed(4)} gasto mesmo assim`);
    return { usd };
  }

  const file: AnalysisVerdictFile = {
    kind: "analysis",
    model: result.model,
    ai_provider: result.provider,
    verified_at: new Date().toISOString(),
    usage: result.usage,
    verdicts: parsed.data,
  };
  writeFileSync(outPath, `${JSON.stringify(file, null, 2)}\n`);

  const refuted = parsed.data.filter((v) => v.verdict === "refutado").length;
  const illegible = parsed.data.filter((v) => v.verdict === "ilegivel").length;
  console.log(
    `  ✓ análise — ${String(parsed.data.length)} afirmações: ${String(parsed.data.length - refuted - illegible)} confirmado(s), ${String(refuted)} refutado(s), ${String(illegible)} ilegível(eis) · $${usd.toFixed(4)}`,
  );
  return { usd };
}

/* ------------------------------------------------------------------ */
/* Summary — reads whatever is on disk (fresh + cached), regardless of  */
/* which files this particular run actually touched.                    */
/* ------------------------------------------------------------------ */

function writeSummary(): { anyRefuted: boolean; toRevisar: string[] } {
  const files = existsSync(VERIFY_DIR) ? readdirSync(VERIFY_DIR).filter((f) => f.endsWith(".verdict.json")).sort() : [];

  const toRevisar: string[] = [];
  const lines: string[] = [
    "# Verificação adversarial — §12.13",
    "",
    `Gerado em ${new Date().toISOString()}.`,
    "",
    `Verificador: \`${MODEL_VERIFY}\` (extrator: \`gemini-3.5-flash\`, analista: \`gemini-3.5-flash-lite\` — famílias diferentes; cross-provider quando uma segunda chave existir).`,
    "",
    "O verificador NUNCA reescreve um valor. Um veredito `refutado` é uma bandeira para revisão humana, não uma correção — o ficheiro extraído/analisado original não é tocado.",
    "",
    "## Extrações",
    "",
    "| Documento | Confirmado | Refutado | Ilegível | Total |",
    "| --- | --- | --- | --- | --- |",
  ];

  let extractionCount = 0;

  for (const f of files) {
    const content = JSON.parse(readFileSync(resolve(VERIFY_DIR, f), "utf8")) as ExtractionVerdictFile | AnalysisVerdictFile;
    if (content.kind === "extraction") {
      extractionCount += 1;
      const refutados = content.verdicts.filter((v) => v.verdict === "refutado");
      const ilegiveis = content.verdicts.filter((v) => v.verdict === "ilegivel");
      const confirmados = content.verdicts.length - refutados.length - ilegiveis.length;
      lines.push(`| ${content.source_file} | ${String(confirmados)} | ${String(refutados.length)} | ${String(ilegiveis.length)} | ${String(content.verdicts.length)} |`);
      for (const r of refutados) {
        toRevisar.push(`${content.source_file}: campo \`${r.field}\` — verificador diz "${r.valor_documento ?? "(sem valor reportado)"}"`);
      }
      if (refutados.length > 0) {
        lines.push("");
        lines.push(`  <details><summary>${content.source_file} — campos refutados</summary>`);
        lines.push("");
        for (const r of refutados) {
          lines.push(`  - \`${r.field}\`: documento mostra "${r.valor_documento ?? "?"}"`);
        }
        lines.push("  </details>");
        lines.push("");
      }
    }
  }
  if (extractionCount === 0) lines.push("| _(nenhuma verificação de extração ainda)_ | | | | |");

  lines.push("", "## Análise (afirmações em prosa)", "");
  const analysisFile = files.find((f) => f === "analysis.verdict.json");
  if (analysisFile === undefined) {
    lines.push("_(análise ainda não verificada)_");
  } else {
    const content = JSON.parse(readFileSync(resolve(VERIFY_DIR, analysisFile), "utf8")) as AnalysisVerdictFile;
    lines.push("| Slot | Afirmação | Veredito | Fundamento |", "| --- | --- | --- | --- |");
    for (const v of content.verdicts) {
      const claimCell = v.claim.replace(/\|/gu, "\\|").slice(0, 160);
      const fundamentoCell = (v.fundamento ?? "").replace(/\|/gu, "\\|").slice(0, 160);
      lines.push(`| ${v.slot} | ${claimCell} | ${v.verdict} | ${fundamentoCell} |`);
      if (v.verdict === "refutado") {
        toRevisar.push(`análise/${v.slot}: "${v.claim.slice(0, 100)}" — ${v.fundamento ?? "(sem fundamento reportado)"}`);
      }
    }
  }

  const anyRefuted = toRevisar.length > 0;
  lines.push("", "## Estado final", "");
  if (anyRefuted) {
    lines.push(`**REVISAR** — ${String(toRevisar.length)} item(ns) refutado(s):`, "");
    for (const item of toRevisar) lines.push(`- ${item}`);
  } else {
    lines.push("Nenhum campo ou afirmação refutado. Nada para `revisar`.");
  }

  lines.push(
    "",
    "## Nota de leitura — refutado na análise nem sempre é erro de facto",
    "",
    "A verificação da análise (§12.13) só recebe os dados de extração CRUS — nunca o contexto",
    "computado em `lib/report-model.ts` (`buildContext()`: rótulos como \"cláusula Quarta\", o",
    "calendário de vencimentos semestrais derivado da periodicidade do contrato). `analyse.ts`",
    "escreve a prosa a partir DESSE contexto computado, não apenas da extração crua — por",
    "desenho (`§3` do POC, os agregados são computados em código, o modelo só escreve prosa à",
    "volta deles). Uma afirmação que cite esse contexto sai \"refutado\" aqui não porque esteja",
    "errada, mas porque este verificador não tem acesso ao mesmo material que o redator teve.",
    "Confirmar manualmente contra `lib/report-model.ts` antes de tratar como erro real.",
  );

  mkdirSync(VERIFY_DIR, { recursive: true });
  writeFileSync(SUMMARY_PATH, `${lines.join("\n")}\n`);
  return { anyRefuted, toRevisar };
}

/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  mkdirSync(VERIFY_DIR, { recursive: true });

  const adapter = getAdapter();
  if (adapter === null) {
    console.error("Nenhuma chave de provider encontrada (GOOGLE_API_KEY no ambiente ou em reportflow/.env).");
    process.exitCode = 1;
    return;
  }

  const args = process.argv.slice(2);
  const doExtractions = !args.includes("--no-extractions");
  const doAnalysis = !args.includes("--no-analysis");
  const requested = args.filter((a) => !a.startsWith("--")).map((a) => basename(a));

  const budget = { spent: 0 };
  let newCalls = 0;

  if (doExtractions) {
    const allExtractionFiles = readdirSync(EXTRACTIONS_DIR)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".invalid.json"))
      .sort();
    const extractionFiles =
      requested.length > 0
        ? allExtractionFiles.filter((f) => requested.some((r) => f.startsWith(basename(r, ".pdf"))))
        : allExtractionFiles;

    console.log(`Verificação adversarial — extrações: ${String(extractionFiles.length)} documento(s) · ${adapter.provider}/${MODEL_VERIFY}\n`);

    for (const f of extractionFiles) {
      const r = await verifyExtraction(adapter, f, budget);
      if (r !== "skipped" && r !== "over-budget") {
        budget.spent += r.usd;
        newCalls += 1;
      }
    }
  }

  if (doAnalysis) {
    console.log(`\nVerificação adversarial — análise · ${adapter.provider}/${MODEL_VERIFY}\n`);
    const r = await verifyAnalysis(adapter, budget);
    if (typeof r === "object") {
      budget.spent += r.usd;
      newCalls += 1;
    }
  }

  console.log(`\n${String(newCalls)} chamada(s) nova(s) · custo total desta corrida $${budget.spent.toFixed(4)}`);

  const { anyRefuted, toRevisar } = writeSummary();
  console.log(`\nResumo gravado em ${SUMMARY_PATH.replace(`${REPO_ROOT}/`, "")}`);

  if (anyRefuted) {
    console.error(`\n✗ ${String(toRevisar.length)} item(ns) refutado(s) — vão para revisar:`);
    for (const item of toRevisar) console.error(`  - ${item}`);
    process.exitCode = 1;
  } else {
    console.log("\n✓ nenhum item refutado.");
  }
}

await main();
