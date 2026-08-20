// api/analysis/verify-job.ts
//
// Hop 3 — the ADVERSARIAL VERIFY (decisions §12.13). Two jobs, one kind, one
// policy: the verifier tries to REFUTE, and it never rewrites.
//
//   EXTRACTION VERIFY — the source PDF + the cached extraction JSON, with a
//   refute-this prompt, returns a verdict per field.
//   ANALYSIS VERIFY  — the `{{ai}}` slot texts + the extraction DATA + the
//   code-computed report context, returns a verdict per factual claim. No PDF
//   (the same §12.3 absence hop 2 already gives).
//
// PORTED FROM poc/verify.ts, prompts included, because that run is where the
// three non-obvious constraints were discovered:
//
//   1. THE EXTRACTION VERIFIER GETS THE FROZEN FIELD LIST. Several fields are
//      specified as NORMALISED or PARAPHRASED rather than verbatim (dates
//      always dd/mm/aaaa however the document prints them, an IBAN without
//      spaces, a multi-line cell condensed to one string, a clause summarised).
//      A verifier that has not seen the spec treats every one of those MANDATED
//      transformations as a discrepancy and drowns the real signal. That
//      happened live on the POC's first pass.
//   2. THE ANALYSIS VERIFIER GETS THE COMPUTED CONTEXT, NOT ONLY THE RAW
//      EXTRACTIONS (§12.13's own amendment). The writer wrote its prose from
//      the aggregates; withholding them makes the verifier refute accurate
//      claims it simply was not shown — observed live, 4 such refutations, all
//      accurate on hand-check. Both inputs are deterministic ground truth, so
//      there is nothing to protect by withholding one.
//   3. A GENEROUS TOKEN BUDGET. `gemini-3.1-pro-preview`'s thinking tokens are
//      billed at, and share, the output budget; 8192 truncated a contract's
//      answer into invalid JSON. Hence 32k for the field pass.
//
// THE VERIFIER IS A DIFFERENT MODEL THAN THE GENERATOR, resolved through
// `resolveModel(…, "verify")` — see api/services/credentials-service.ts on why
// an account-level model override deliberately does not reach this hop.

import { createHash } from "node:crypto";
import { fieldsToPrompt, type FieldSpec } from "../../shared/validation";
import type { SlotDeclarationT } from "../../shared/validation/outbound-schemas";
import { VERDICTS } from "../../shared/validation/verify-schemas";
import { billingBinding } from "../billing/charge";

/** What a verify job is about. Rides the payload, read back by the collector. */
export type VerifyTarget = "extraction" | "analysis";

export const VERIFY_CONTEXT_KEY = "reportVerify";

export type VerifyContext =
  | {
      readonly target: "extraction";
      readonly extractionId: string;
      readonly documentId: string;
    }
  | {
      readonly target: "analysis";
      readonly reportId: string;
      readonly templateVersionId: string;
      /**
       * `{ slug: sha256hex(text) }` — WHAT THE VERIFIER ACTUALLY JUDGED.
       *
       * A verdict is a claim about a specific piece of prose, and ~60 seconds
       * pass between this job being built and its answer landing. Without this
       * snapshot, a human who rewrites a slot in that window gets the previous
       * text's refutation attached to prose the verifier never saw — a report
       * blocked on a finding about words that no longer exist, which is worse
       * than no verdict at all because the reason on screen does not match
       * anything the reader can find.
       *
       * A HASH, not the text: the text is already in the prompt, and
       * `report_jobs.request` is a jsonb column, not an archive. The keys are
       * also the slug list — one fact, not two that can drift.
       */
      readonly textHashes: Readonly<Record<string, string>>;
    };

/**
 * The digest a verdict is bound to. sha256 hex over the UTF-8 text, exactly as
 * it was sent — no trimming, no normalisation. A whitespace-only edit is still
 * an edit, and the cheap answer ("re-verify") is better than guessing which
 * changes were material.
 */
export function slotTextHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** §12.6's `report_verify:{provider}:{model}:{refKey}`, minus the grammar.
 * Keyed on the ARTIFACT being audited, exactly like the other two. */
export function extractionVerifyRefKey(s3Key: string, calibrationRev: number): string {
  return `extraction:${s3Key}:${String(calibrationRev)}`;
}

export function analysisVerifyRefKey(
  reportId: string,
  templateVersionId: string,
  extractionIds: readonly string[],
): string {
  return `analysis:${reportId}:${templateVersionId}:${[...extractionIds].sort().join(",")}`;
}

// ---------------------------------------------------------------------------
// Prompts — poc/verify.ts, verbatim
// ---------------------------------------------------------------------------

const SYSTEM_EXTRACTION = [
  "Você é um auditor adversarial independente. Os dados abaixo foram extraídos de um documento por OUTRO modelo (o extrator), seguindo a especificação de campos fornecida.",
  "O seu papel não é confirmar a extração — é tentar REFUTÁ-LA. Presuma que ela pode conter erros e procure-os ativamente:",
  "um dígito trocado, uma data incorreta, um valor arredondado ou mal transcrito, um nome truncado, um IBAN parcialmente errado, um campo copiado do exemplar errado, uma obrigação inventada ou omitida, uma paráfrase que muda o SENTIDO da cláusula original.",
  "Compare cada campo, um a um, com o documento PDF anexado E com o que a especificação de campos (abaixo) pediu para aquele campo.",
  "IMPORTANTE — a especificação de campos pede explicitamente certas NORMALIZAÇÕES: datas sempre em dd/mm/aaaa (não importa como o documento as imprime), um IBAN sem espaços, o texto de uma célula que se estende por várias linhas do documento condensado numa só string, um resumo, uma paráfrase ou um rótulo curto em vez de uma citação literal. Quando a descrição do campo pede isso, aplicar essa transformação é o comportamento CORRETO — NÃO é uma refutação. Quebras de linha dentro de uma célula ou parágrafo do documento nunca são, por si só, uma diferença de conteúdo: normalize espaços em branco antes de comparar.",
  "Refute apenas quando o CONTEÚDO factual diverge do documento — um valor diferente, uma data diferente, uma cláusula com sentido diferente, uma obrigação inventada ou omitida — não quando apenas a formatação, a pontuação ou a extensão do texto mudam de acordo com o que a especificação pediu.",
  "Regras invioláveis:",
  "1. Nunca corrija o valor você mesmo. Se encontrar uma discrepância real de conteúdo, relate em valor_documento o que o documento REALMENTE mostra, de forma concisa (uma frase).",
  '2. verdict="confirmado" quando o CONTEÚDO bate com o documento, incluindo quando a especificação do campo pediu uma normalização/resumo/paráfrase e a extração cumpriu essa instrução fielmente.',
  '3. verdict="refutado" quando o CONTEÚDO diverge do documento, para além do que a especificação do campo permite.',
  '4. verdict="ilegivel" quando o documento não permite confirmar nem refutar (zona ilegível, página em falta, campo cortado).',
  "5. Não omita nenhum campo: percorra o JSON campo a campo, incluindo cada elemento de cada array (use notação de caminho: itens[0].total, obrigacoes[2].detalhe, etc.).",
  "6. Devolva um objeto com a chave `verdicts` contendo a lista de vereditos.",
].join("\n");

const SYSTEM_ANALYSIS = [
  "Você é um auditor adversarial independente. O texto abaixo foi escrito por OUTRO modelo (o redator) a partir dos dados fornecidos.",
  "O seu papel não é elogiar a prosa — é tentar REFUTAR cada afirmação factual nela contida, comparando-a com os DADOS DE EXTRAÇÃO e com o CONTEXTO CALCULADO fornecidos (nenhum PDF foi fornecido nesta etapa; esses dois blocos são a ÚNICA fonte permitida, e ambos são verdade determinística).",
  'Decomponha cada slot em afirmações factuais discretas — cada número, cada data, cada contagem de documentos, cada referência bancária, e cada afirmação causal ou de conformidade (ex.: "em conformidade exata com", "distinto de", "anterior a") é UMA afirmação a avaliar separadamente.',
  "Regras invioláveis:",
  "1. Nunca reescreva o texto. Relate apenas o veredito e, quando necessário, o fundamento.",
  '2. verdict="confirmado" apenas se TODO número/data/contagem/referência na afirmação estiver sustentado, exatamente, pelos dados OU pelo contexto calculado.',
  '3. verdict="refutado" se a afirmação contradiz esses dados ou não pode ser reconstruída a partir deles (um número que não aparece em lado nenhum, uma soma errada, uma contagem errada, uma comparação incorreta).',
  '4. verdict="ilegivel" apenas se os dados fornecidos forem literalmente insuficientes para decidir (raro).',
  "5. Cubra pelo menos: todo número monetário, toda data, toda contagem de documentos, e toda afirmação causal ou de conformidade em cada slot.",
  "6. `fundamento` deve ser conciso (uma frase).",
  "7. Devolva um objeto com a chave `verdicts` contendo a lista de vereditos.",
].join("\n");

// ---------------------------------------------------------------------------
// Provider-neutral schemas
// ---------------------------------------------------------------------------

/**
 * `{ verdicts: [...] }` — an OBJECT root, not the POC's bare array.
 *
 * api/collector/relay-result.ts `parseModelJson` refuses an array for a stated
 * reason (every consumer of a model answer addresses it by field name), and
 * teaching it an exception for one hop would weaken the rule for all of them.
 */
function verdictsEnvelope(
  itemProps: Record<string, unknown>,
  required: readonly string[],
): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      verdicts: {
        type: "array",
        items: {
          type: "object",
          properties: itemProps,
          required: [...required],
          additionalProperties: false,
        },
      },
    },
    required: ["verdicts"],
    additionalProperties: false,
  };
}

export const FIELD_VERDICT_JSON_SCHEMA = verdictsEnvelope(
  {
    field: {
      type: "string",
      description:
        "Caminho do campo tal como no JSON de extração, ex.: totais.iliquido ou itens[0].preco.",
    },
    verdict: {
      type: "string",
      enum: [...VERDICTS],
      description:
        "confirmado = o documento mostra exatamente este valor; refutado = o documento mostra outra coisa; ilegivel = o documento não permite confirmar nem refutar.",
    },
    valor_documento: {
      type: ["string", "null"],
      description:
        "O que o documento REALMENTE mostra — preencha SOMENTE quando verdict=refutado; caso contrário null.",
    },
  },
  ["field", "verdict", "valor_documento"],
);

export const CLAIM_VERDICT_JSON_SCHEMA = verdictsEnvelope(
  {
    slot: { type: "string", description: "O slug do slot de prosa a que a afirmação pertence." },
    claim: {
      type: "string",
      description: "A afirmação factual isolada, tal como aparece (ou parafraseada minimamente).",
    },
    verdict: {
      type: "string",
      enum: [...VERDICTS],
      description:
        "confirmado = sustentado exatamente pelos dados; refutado = contradito ou não sustentado; ilegivel = não é possível verificar com os dados dados.",
    },
    fundamento: {
      type: ["string", "null"],
      description:
        "Por que a afirmação não está sustentada — preencha SOMENTE quando verdict != confirmado; caso contrário null.",
    },
  },
  ["slot", "claim", "verdict", "fundamento"],
);

/** poc/verify.ts's own ceilings, and the comment on why the first one is that
 * high is in this file's header. */
export const EXTRACTION_VERIFY_MAX_TOKENS = 32_768;
export const ANALYSIS_VERIFY_MAX_TOKENS = 16_384;

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export interface ExtractionVerifyJobInput {
  readonly tenantId: string;
  readonly extractionId: string;
  readonly documentId: string;
  /** The PDF. The one hop after extraction that still reads one (§12.13). */
  readonly s3Key: string;
  readonly calibrationRev: number;
  /** The SAME frozen list the extractor was calibrated against — see 1. above. */
  readonly fields: readonly FieldSpec[];
  readonly data: unknown;
  readonly providerName?: string | undefined;
  readonly documentTypeName?: string | undefined;
  readonly provider: string;
  readonly model: string;
  readonly ssmParamName?: string | undefined;
}

export function buildExtractionVerifyJob(input: ExtractionVerifyJobInput): Record<string, unknown> {
  if (input.fields.length === 0) {
    throw new Error("buildExtractionVerifyJob: frozen field list is empty");
  }
  const heading = [input.providerName, input.documentTypeName]
    .filter((part): part is string => part !== undefined)
    .join(" / ");

  const prompt = [
    `Documento fonte anexado (PDF).${heading.length > 0 ? ` Tipo: ${heading}.` : ""}`,
    "",
    "Especificação de campos que o extrator recebeu (o que cada campo DEVE conter, incluindo normalizações/resumos pedidos):",
    fieldsToPrompt(input.fields),
    "",
    "Dados extraídos por OUTRO modelo, que você deve tentar refutar:",
    JSON.stringify(input.data, null, 2),
  ].join("\n");

  return {
    channel: "ai",
    kind: "verify",
    tenantId: input.tenantId,
    provider: input.provider,
    model: input.model,
    system: SYSTEM_EXTRACTION,
    prompt,
    document: { s3Key: input.s3Key },
    schema: FIELD_VERDICT_JSON_SCHEMA,
    maxTokens: EXTRACTION_VERIFY_MAX_TOKENS,
    ...(input.ssmParamName === undefined ? {} : { ssmParamName: input.ssmParamName }),
    ...billingBinding({
      source: "verify",
      refKey: extractionVerifyRefKey(input.s3Key, input.calibrationRev),
    }),
    [VERIFY_CONTEXT_KEY]: {
      target: "extraction",
      extractionId: input.extractionId,
      documentId: input.documentId,
    },
  };
}

export interface AnalysisVerifyJobInput {
  readonly tenantId: string;
  readonly reportId: string;
  readonly templateVersionId: string;
  readonly extractionIds: readonly string[];
  /** The declarations, so the verifier knows what each slot was ASKED for —
   * the analysis-side equivalent of handing the field list to hop A. */
  readonly slots: readonly SlotDeclarationT[];
  /** `{ slug: text }` for the slots that actually have prose. */
  readonly texts: Readonly<Record<string, string>>;
  /** The extraction DATA, by role. Raw ground truth. */
  readonly extractionData: unknown;
  /** `buildReportContext(...).context` — §12.13's amendment, see 2. above. */
  readonly computedContext: Record<string, unknown>;
  readonly provider: string;
  readonly model: string;
  readonly ssmParamName?: string | undefined;
}

export function buildAnalysisVerifyJob(input: AnalysisVerifyJobInput): Record<string, unknown> {
  const slugs = Object.keys(input.texts);
  if (slugs.length === 0) {
    throw new Error("buildAnalysisVerifyJob: no prose to audit");
  }

  const prompt = [
    "DADOS DE EXTRAÇÃO (verdade determinística — nenhum PDF foi fornecido nesta etapa):",
    JSON.stringify(input.extractionData, null, 2),
    "",
    "CONTEXTO CALCULADO EM CÓDIGO (agregados, totais e metadados que o redator recebeu; também verdade determinística — §12.12b):",
    JSON.stringify(input.computedContext, null, 2),
    "",
    "ORIENTAÇÃO DADA A CADA SLOT (o que cada secção foi mandada escrever):",
    ...input.slots
      .filter((slot) => slugs.includes(slot.slug))
      .map((slot) => `- ${slot.slug}: ${slot.guideline}`),
    "",
    "TEXTO A AUDITAR, por slot:",
    JSON.stringify(input.texts, null, 2),
  ].join("\n");

  return {
    channel: "ai",
    kind: "verify",
    tenantId: input.tenantId,
    provider: input.provider,
    model: input.model,
    system: SYSTEM_ANALYSIS,
    prompt,
    // NO `document` — the same absence-as-guarantee hop 2 gives (§12.3).
    schema: CLAIM_VERDICT_JSON_SCHEMA,
    maxTokens: ANALYSIS_VERIFY_MAX_TOKENS,
    ...(input.ssmParamName === undefined ? {} : { ssmParamName: input.ssmParamName }),
    ...billingBinding({
      source: "verify",
      refKey: analysisVerifyRefKey(input.reportId, input.templateVersionId, input.extractionIds),
    }),
    [VERIFY_CONTEXT_KEY]: {
      target: "analysis",
      reportId: input.reportId,
      templateVersionId: input.templateVersionId,
      // The snapshot the verdicts are bound to. See `VerifyContext`.
      textHashes: Object.fromEntries(
        slugs.map((slug) => [slug, slotTextHash(input.texts[slug] ?? "")]),
      ),
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The inverse. `null` for a `verify` job this code did not build. */
export function readVerifyContext(request: unknown): VerifyContext | null {
  const payload = asRecord(request);
  const raw = payload === null ? null : asRecord(payload[VERIFY_CONTEXT_KEY]);
  if (raw === null) {
    return null;
  }
  const target = raw["target"];
  if (target === "extraction") {
    const extractionId = raw["extractionId"];
    const documentId = raw["documentId"];
    if (typeof extractionId !== "string" || typeof documentId !== "string") {
      return null;
    }
    return { target: "extraction", extractionId, documentId };
  }
  if (target === "analysis") {
    const reportId = raw["reportId"];
    const templateVersionId = raw["templateVersionId"];
    const hashes = asRecord(raw["textHashes"]);
    if (typeof reportId !== "string" || typeof templateVersionId !== "string") {
      return null;
    }
    if (hashes === null) {
      return null;
    }
    const textHashes: Record<string, string> = {};
    for (const [slug, hash] of Object.entries(hashes)) {
      if (typeof hash !== "string" || hash.length === 0) {
        return null;
      }
      textHashes[slug] = hash;
    }
    return { target: "analysis", reportId, templateVersionId, textHashes };
  }
  return null;
}
