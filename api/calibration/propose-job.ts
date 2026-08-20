// api/calibration/propose-job.ts
//
// The "AI proposes" half of Calibrate (decisions §3.1, §3.3). Builds the
// canonical relay job payload (relay/src/job.ts `AiJob`) that reads ONE sample
// PDF and comes back with a DRAFT of the three things §3.1 freezes together:
// the ordered field list, an `input_mode` recommendation, and `detect_hint`
// candidates. It does not enqueue (api/lib/relay.ts does) and does not store
// anything — §3.1's whole point is that a human edits this before it becomes
// a template.
//
// WHY `kind: "analyse"` AND NOT A NEW KIND. The job kinds are a closed set in
// three places at once: the `report_jobs_kind_check` CHECK constraint, the
// relay's own `JOB_KINDS` (relay/src/job.ts), and api/collector/job-state.ts.
// A `calibrate` kind would mean a migration, a relay deploy and a collector
// change to teach three components a distinction only ONE of them cares
// about. What the collector actually needs to know about this job is exactly
// what it already knows about `analyse`: "the result IS the artifact" — no
// extraction to cache, no per-field repair screen, `failed` rather than
// `revisar` on a bad hop (api/collector/collect.ts). So this rides `analyse`
// and marks its purpose in the PAYLOAD instead:
//
//     { channel: "ai", kind: "analyse", purpose: "calibrate", … }
//
// `purpose` survives where it is needed and vanishes where it is not, for
// free: `report_jobs.request` stores the payload verbatim (which is how the
// API tells a calibrate proposal from a report analysis when a job comes
// back), while `parseJob` reconstructs a fresh `AiJob` from the keys it knows
// and simply drops the rest — so the relay never has to learn the word.

import { FIELD_TYPES, INPUT_MODES, LEAF_FIELD_TYPES } from "../../shared/validation/field-spec";

/** The marker that distinguishes a Calibrate proposal from a report analysis
 * on an otherwise identical `analyse` job row. */
export const CALIBRATE_PURPOSE = "calibrate";

/** Only adapter registered today (relay/src/providers/registry.ts). The
 * FLASH tier, not flash-lite: this hop reads a whole document and has to
 * invent a field list from it, which is the one Calibrate call a tenant makes
 * per document type — the cheapest possible model is a false economy against
 * a list a human then has to repair by hand. */
export const CALIBRATE_PROVIDER = "gemini";
export const CALIBRATE_MODEL = "gemini-3.5-flash";

/** Room for ~40 fields with descriptions plus the sample values. Well under
 * `MAX_MAX_TOKENS`; a proposal that needs more than this is a document type
 * nobody should be freezing in one pass. */
export const CALIBRATE_MAX_TOKENS = 16_384;

/** How much page-1 text the model is shown. Enough for a header block and a
 * table's first rows — the region `detect_hint` candidates come from — while
 * staying far below relay/src/job.ts's `MAX_PROMPT`. */
export const PAGE_TEXT_BUDGET = 6_000;

const SYSTEM_PROMPT = [
  "Você calibra a extração de um tipo de documento comercial a partir de UM exemplar.",
  "Você propõe; um humano revisa e congela. Proponha o que for útil e verificável, nunca invente.",
  "Regras invioláveis:",
  "1. Valores monetários são do tipo 'money' e são devolvidos VERBATIM, exatamente como impressos (separador de milhar, vírgula decimal, símbolo). Nunca converta para número.",
  "2. Datas impressas são do tipo 'date' (dd/mm/aaaa).",
  "3. Use 'integer'/'decimal' apenas para quantidades sem formatação monetária.",
  "4. Linhas repetidas (itens, parcelas) são UM campo 'object[]' com subcampos, nunca um campo por linha.",
  "5. Cada 'description' deve permitir reencontrar o campo pelo RÓTULO impresso, mesmo que o layout mude. Descreva o rótulo, não a posição na página.",
  "6. Não proponha campos que não estejam no documento.",
].join("\n");

function fieldNodeSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      name: { type: "string", description: "identificador snake_case, ex.: cliente_nome" },
      type: { type: "string", enum: [...FIELD_TYPES] },
      required: {
        type: "boolean",
        description: "true se o campo aparece em todos os documentos deste tipo",
      },
      description: {
        type: "string",
        description: "o rótulo impresso e como distingui-lo de campos parecidos",
      },
      fields: {
        type: "array",
        description: "subcampos — apenas para type 'object' ou 'object[]'",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            type: { type: "string", enum: [...LEAF_FIELD_TYPES] },
            required: { type: "boolean" },
            description: { type: "string" },
          },
          required: ["name", "type", "required", "description"],
        },
      },
    },
    required: ["name", "type", "required", "description"],
  };
}

/** The proposal's own output schema. Mirrors `CalibrationProposalZ`
 * (shared/validation/calibration-schemas.ts), which is what actually decides
 * whether the answer is usable — this is the REQUEST, not a guarantee. */
export function buildProposalSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      document_type_name: {
        type: "string",
        description: "nome curto do tipo de documento, ex.: 'Nota Fiscal', 'Contrato'",
      },
      input_mode: {
        type: "string",
        enum: [...INPUT_MODES],
        description:
          "'text' se o PDF tiver camada de texto utilizável; 'vision' apenas se for digitalização sem texto",
      },
      detect_hint: {
        type: "array",
        items: { type: "string" },
        description:
          "2 a 3 trechos curtos, copiados LITERALMENTE do texto da página 1, presentes em todos os documentos deste tipo",
      },
      fields: { type: "array", items: fieldNodeSchema() },
      sample_values_json: {
        type: "string",
        description:
          "objeto JSON (como string) com os valores deste exemplar, usando exatamente os nomes de campo propostos",
      },
    },
    required: ["document_type_name", "input_mode", "detect_hint", "fields", "sample_values_json"],
  };
}

export interface CalibrateJobInput {
  readonly tenantId: string;
  /** The sample document's own S3 key — the same handle every other hop uses. */
  readonly s3Key: string;
  readonly providerName?: string | undefined;
  readonly documentTypeName?: string | undefined;
  /**
   * Page-1 text, extracted LOCALLY before this job was built
   * (api/detection/page-text.ts), or null when the PDF has no text layer.
   *
   * Two jobs at once, and both matter. It is the EVIDENCE for the
   * `input_mode` recommendation — that is a cost decision (§3.1) and the fact
   * it turns on is one we can establish for free, so the model is TOLD the
   * answer rather than asked to guess it from a rendered page. And it is the
   * source `detect_hint` candidates must be copied from: tier 1 matches
   * substrings against this exact extraction (§3.3), so a hint the model
   * invented from the visual layout can be perfectly accurate about the page
   * and still never match.
   */
  readonly pageOneText: string | null;
}

function buildPrompt(input: CalibrateJobInput): string {
  const pageOneText = input.pageOneText;
  const context = [
    input.providerName === undefined ? null : `Fornecedor: ${input.providerName}.`,
    input.documentTypeName === undefined
      ? null
      : `Tipo de documento (indicado pelo humano): ${input.documentTypeName}.`,
  ].filter((line): line is string => line !== null);

  const textLayerNote =
    pageOneText !== null
      ? [
          "CAMADA DE TEXTO: este PDF TEM camada de texto legível (verificado localmente).",
          "Portanto input_mode deve ser 'text'.",
          "",
          "Texto da página 1 (use-o para copiar detect_hint literalmente):",
          "---",
          pageOneText.slice(0, PAGE_TEXT_BUDGET),
          "---",
        ]
      : [
          "CAMADA DE TEXTO: este PDF NÃO tem camada de texto (é uma digitalização, verificado localmente).",
          "Portanto input_mode deve ser 'vision', e detect_hint provavelmente não será útil —",
          "devolva uma lista vazia se não houver texto extraível.",
        ];

  return [
    "Analise o PDF anexado e proponha a calibração deste tipo de documento.",
    ...context,
    "",
    ...textLayerNote,
    "",
    "Devolva:",
    "1. document_type_name — o nome deste tipo de documento.",
    "2. input_mode — conforme a nota acima.",
    "3. detect_hint — 2 a 3 trechos distintivos da página 1, copiados literalmente,",
    "   que apareçam em TODOS os documentos deste tipo (nunca um número de fatura ou uma data).",
    "4. fields — a lista ordenada de campos a extrair, com nome, tipo, obrigatoriedade e descrição.",
    "5. sample_values_json — os valores deste exemplar, em JSON, com os nomes de campo propostos.",
  ].join("\n");
}

/**
 * Builds the `analyse`/`calibrate` payload. `Record<string, unknown>` and not
 * a typed job, per `enqueueRelayJob`'s own contract (api/lib/relay.ts): the
 * relay is the authority on whether a payload is a job, and a second type
 * here is how the two drift.
 */
export function buildCalibrateJob(input: CalibrateJobInput): Record<string, unknown> {
  return {
    channel: "ai",
    kind: "analyse",
    purpose: CALIBRATE_PURPOSE,
    tenantId: input.tenantId,
    provider: CALIBRATE_PROVIDER,
    model: CALIBRATE_MODEL,
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(input),
    document: { s3Key: input.s3Key },
    schema: buildProposalSchema(),
    maxTokens: CALIBRATE_MAX_TOKENS,
  };
}

/**
 * Is this stored `report_jobs.request` a Calibrate proposal?
 *
 * The one thing that separates this job from a report analysis on the same
 * `kind`. Read from the stored payload rather than from a column: adding a
 * column would be the migration this design avoided, and the payload is
 * already kept verbatim so the collector can re-enqueue a retry (§4.2).
 */
export function isCalibrateRequest(request: unknown): boolean {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return false;
  }
  return (request as Record<string, unknown>)["purpose"] === CALIBRATE_PURPOSE;
}
