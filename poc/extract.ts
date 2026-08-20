/**
 * Hop 1 — extraction. One PDF in, one validated JSON out.
 *
 *   pnpm tsx poc/extract.ts            # all faturas + contrato
 *   pnpm tsx poc/extract.ts FT_C2025_141.pdf
 *
 * Note what this file does NOT contain: a provider name, an SDK import, or an
 * API key. It builds the canonical §6 job and hands it to the registry.
 *
 * Idempotent by construction (§4, "extraction cached"): the cache key is
 * (file, calibration_rev) — §12.8 — and an already-extracted file is SKIPPED,
 * not re-read. Rerunning this script costs nothing. That is a billing guard, not
 * a speed optimisation: re-reading the same PDF must never bill twice, which is
 * exactly what a human does when a read looks wrong (§7).
 *
 * §4.2 failure policy, in miniature: Zod-invalid -> retry once -> then park the
 * raw payload as `.invalid.json` for a human field-by-field pass ("revisar"),
 * rather than throwing nineteen good fields away to recover one bad one.
 */
import { readdirSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import type { ZodType } from "zod";
import { CONTRATO_TEMPLATE, contratoSchema } from "./fields/contrato.ts";
import { FATURA_TEMPLATE, faturaSchema } from "./fields/fatura.ts";
import type { ExtractTemplate } from "./fields/spec.ts";
import { fieldsToJsonSchema, fieldsToPrompt } from "./fields/spec.ts";
import type { AiAdapter } from "./lib/ai.ts";
import { callWithRetry, costUsd, getAdapter, MODEL_EXTRACT, REPO_ROOT } from "./lib/ai.ts";

const PDF_DIR = resolve(REPO_ROOT, "pdf");
const OUT_DIR = resolve(REPO_ROOT, "poc", "out", "extractions");

const SYSTEM = [
  "Você extrai campos de documentos comerciais portugueses com precisão literal.",
  "Regras invioláveis:",
  "1. Valores monetários são devolvidos VERBATIM, exatamente como impressos, incluindo o separador de milhar '.', a vírgula decimal e o símbolo €. Nunca converta para número, nunca arredonde, nunca reformate.",
  "2. Datas no formato dd/mm/aaaa.",
  "3. Não infira, não calcule, não complete. Se um campo não estiver no documento e for opcional, devolva null.",
  "4. Devolva apenas os campos pedidos.",
].join("\n");

/** §3.3 tier 1: substring match on page-1 text. Free, instant, human-verified. */
function detectType(file: string): ExtractTemplate {
  // The real pipeline reads the page-1 text layer locally (§12.2). Here the
  // filename carries the same signal; what matters is the fallthrough, and the
  // contract exercises it for real — it is a scan with no text layer at all.
  return /^FT_C\d{4}_\d+\.pdf$/u.test(file) ? FATURA_TEMPLATE : CONTRATO_TEMPLATE;
}

function schemaFor(template: ExtractTemplate): ZodType {
  return template.documentType === "fatura" ? faturaSchema : contratoSchema;
}

/** §12.8 — the calibration generation participates in the key, so recalibrating
 * invalidates instead of silently serving a stale read. */
function cacheKey(file: string, template: ExtractTemplate): string {
  return `${basename(file, ".pdf")}.rev${String(template.calibrationRev)}.json`;
}

async function extractOne(adapter: AiAdapter, file: string): Promise<{ usd: number } | "skipped"> {
  const template = detectType(file);
  const outPath = resolve(OUT_DIR, cacheKey(file, template));

  if (existsSync(outPath)) {
    console.log(`  = ${file} — já extraído (cache), a saltar`);
    return "skipped";
  }

  const prompt = [
    `Documento: ${template.provider} / ${template.documentType}.`,
    "",
    "Extraia exatamente estes campos:",
    fieldsToPrompt(template.fields),
    "",
    template.documentType === "fatura"
      ? "IMPORTANTE: este PDF contém a MESMA fatura repetida em três exemplares (Original, Duplicado, Triplicado). Extraia uma única vez, a partir do exemplar Original."
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  console.log(`  → ${file} (${template.documentType}, input_mode=${template.inputMode})`);

  const result = await callWithRetry(
    adapter,
    {
      system: SYSTEM,
      prompt,
      documentPath: resolve(PDF_DIR, file),
      // Built from the SAME frozen field list Zod validates against.
      schema: fieldsToJsonSchema(template.fields),
      schemaName: `extracao_${template.documentType}`,
      maxTokens: 8192,
    },
    MODEL_EXTRACT,
  );

  const usd = costUsd(result.model, result.usage);

  // The provider's structured-output mode is a convenience, not the guarantee.
  // OUR Zod schema — built at runtime from the frozen field list — is what
  // decides whether this extraction is usable (§3.1, §12.4).
  let payload: unknown;
  try {
    payload = JSON.parse(result.text) as unknown;
  } catch {
    payload = { __unparseable: result.text };
  }
  const parsed = schemaFor(template).safeParse(payload);

  if (!parsed.success) {
    // §4.2 — park it for "revisar", never discard the paid read.
    const invalidPath = outPath.replace(/\.json$/u, ".invalid.json");
    writeFileSync(invalidPath, `${JSON.stringify({ raw: payload, issues: parsed.error.issues }, null, 2)}\n`);
    console.error(`  ✗ ${file} — schema inválido, guardado em ${basename(invalidPath)} para revisão`);
    return { usd };
  }

  writeFileSync(
    outPath,
    `${JSON.stringify(
      {
        source_file: file,
        document_type: template.documentType,
        provider: template.provider,
        calibration_rev: template.calibrationRev,
        input_mode: template.inputMode,
        model: result.model,
        ai_provider: result.provider,
        extracted_at: new Date().toISOString(),
        usage: result.usage,
        data: parsed.data,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`  ✓ ${file} — ${String(result.usage.input_tokens)} in / ${String(result.usage.output_tokens)} out · $${usd.toFixed(4)}`);
  return { usd };
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const adapter = getAdapter();
  if (adapter === null) {
    console.error("Nenhuma chave de provider encontrada (GOOGLE_API_KEY no ambiente ou em reportflow/.env).");
    console.error("Extração ao vivo indisponível. Use as extrações mock:  pnpm tsx poc/out/mock-seed.ts");
    process.exitCode = 1;
    return;
  }

  const requested = process.argv.slice(2);
  const files =
    requested.length > 0
      ? requested.map((f) => basename(f))
      : readdirSync(PDF_DIR)
          .filter((f) => f.endsWith(".pdf") && !f.startsWith("Relatorio_"))
          .sort();

  console.log(`Extração — ${String(files.length)} documento(s) · ${adapter.provider}/${MODEL_EXTRACT}\n`);

  let total = 0;
  let done = 0;
  for (const file of files) {
    const r = await extractOne(adapter, file);
    if (r !== "skipped") {
      total += r.usd;
      done += 1;
    }
  }

  console.log(`\n${String(done)} extração(ões) nova(s) · custo total $${total.toFixed(4)}`);
}

await main();
