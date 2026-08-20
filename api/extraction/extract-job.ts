// api/extraction/extract-job.ts
//
// Hop 1 (decisions §4): the canonical relay job that reads ONE document
// against ONE frozen field list and comes back with JSON. It builds the
// payload and nothing else — it does not enqueue (api/lib/relay.ts does), does
// not read the result (api/collector/collect.ts does), and does not decide
// whether the answer is usable (shared/validation/extraction-validation.ts
// does).
//
// PORTED FROM poc/extract.ts, which proved this prompt shape against real
// documents. The three things the POC established, kept verbatim:
//
//   1. The field list becomes the prompt (`fieldsToPrompt`) AND the provider
//      schema (`fieldsToJsonSchema`) AND the validator (`buildZodSchema`) —
//      one frozen list, three renderings, no hand-written schema anywhere
//      (§3.1).
//   2. Money is returned VERBATIM. The POC's system prompt makes that rule
//      inviolable and names the failure it prevents (a model reformatting
//      "1.234,56 €" into a float loses the cent before anything can check).
//   3. The model SELF-REPORTS the page (§6.1). `citations:{enabled:true}`
//      returns verified `page_location` grounding but 400s when combined with
//      `output_config.format`, and structured output is the half of that
//      trade this pipeline cannot give up.
//
// INPUT MODE IS A COST DECISION, NOT A FALLBACK LADDER (§3.1). `vision` sends
// the PDF by `document.s3Key` and the relay hands the provider the file;
// `text` sends NO document at all and embeds the locally-extracted text layer
// in the prompt instead. There is deliberately no "text mode, but fall back to
// vision if the text is thin" branch: that would silently spend 5–20× the
// budgeted cost on a document type whose calibration says it should not, and
// the human who chose `text` during Calibrate is the one who should learn the
// choice was wrong.

import {
  fieldsToJsonSchema,
  fieldsToPrompt,
  isFieldType,
  type FieldSpec,
} from "../../shared/validation";
import type { InputMode } from "../../shared/validation/field-spec";
import { billingBinding } from "../billing/charge";

// Model choice for this hop now lives in api/services/credentials-service.ts
// (`PLATFORM_DEFAULTS.extract`, §6's "account-level default, settable per
// hop") — #10 replaced the constants that used to sit here, together with the
// TODO that pointed at it. This file is handed a (provider, model) pair and a
// key binding; it does not know or care whose key pays.

/** Room for a long line-item table plus the wrapper. §6.2 budgets ~2k output
 * tokens for this hop; 8192 is the POC's own ceiling and leaves headroom for a
 * document with more rows than the sample had. */
export const EXTRACT_MAX_TOKENS = 8_192;

/**
 * How much locally-extracted text a `text`-mode job may carry.
 *
 * Well under relay/src/job.ts's `MAX_PROMPT` (262 144), because the prompt
 * also carries the field list and the instructions, and a job the relay
 * refuses as too long is a job that fails permanently after the API already
 * paid to build it. A document whose text layer exceeds this is a document
 * that should have been calibrated `vision`.
 */
export const DOCUMENT_TEXT_BUDGET = 180_000;

/**
 * §12.6's charge key for this hop, minus the grammar
 * (api/billing/charge.ts `chargeRefId` owns that):
 *
 *     report_extraction:{provider}:{model}:{s3Key}
 *
 * The S3 key and nothing else, which is §7's own sentence made literal: the
 * charge is idempotent on the ARTIFACT, not the job — "re-reading the same PDF
 * must not bill twice, which is exactly what a user does when a read looks
 * wrong". The retry §4.2 allows therefore costs the platform a second provider
 * call and the customer nothing, which is the point.
 */
export function extractionRefKey(s3Key: string): string {
  return s3Key;
}

const SYSTEM_PROMPT = [
  "Você extrai campos de documentos comerciais com precisão literal.",
  "Regras invioláveis:",
  "1. Valores monetários são devolvidos VERBATIM, exatamente como impressos, incluindo o separador de milhar, a vírgula decimal e o símbolo da moeda. Nunca converta para número, nunca arredonde, nunca reformate.",
  "2. Datas no formato dd/mm/aaaa, como impressas.",
  "3. Não infira, não calcule, não complete. Se um campo não estiver no documento e for opcional, devolva null.",
  "4. Devolva apenas os campos pedidos, com exatamente os nomes pedidos.",
].join("\n");

/**
 * The template facts an extract job is BOUND to, carried in the payload and
 * therefore surviving on `report_jobs.request` (codex review, 2026-08-20).
 *
 * WHY THE JOB CARRIES ITS OWN FIELD LIST. §12.8 says recalibration
 * INVALIDATES: it bumps `calibration_rev` and every affected document
 * re-extracts. That is a race the collector could not see. A job enqueued
 * against rev N comes back ~30s later; if a human froze rev N+1 in between,
 * a collector that re-read the LIVE rows would validate the model's answer
 * against a field list the model was never shown — flagging correct values as
 * wrong, or worse, accepting an answer and caching it under rev N+1 as though
 * it had been produced for it.
 *
 * So the job is SELF-CONTAINED: the list the model was shown is the list its
 * answer is judged by, and the rev it was built for is stated. The collector
 * then compares that rev against the live one before caching anything and
 * refuses to store a stale answer at all. The list is small (§3.1 caps a
 * frozen list at 120 fields) and `report_jobs.request` is already the
 * surviving copy — the relay DELETES the job object once it writes a result,
 * which is why the retry path reads that column too.
 *
 * The relay never sees any of this: `parseJob` (relay/src/job.ts)
 * reconstructs an `AiJob` from the keys it knows and drops the rest, the same
 * way `purpose` rides an `analyse` job in api/calibration/propose-job.ts.
 */
export interface ExtractContext {
  readonly templateId: string;
  readonly calibrationRev: number;
  readonly fields: readonly FieldSpec[];
}

/** The payload key `ExtractContext` rides on. Named once so the writer and
 * the reader below cannot disagree about it. */
export const EXTRACT_CONTEXT_KEY = "extractTemplate";

/**
 * The `report_jobs.error` the collector writes when a template moved while its
 * extraction was in flight (§12.8).
 *
 * A CONSTANT, and it lives HERE, because three parties need to agree on this
 * one state and two of them are on opposite sides of the pipeline: the
 * collector writes it (api/collector/collect.ts) and the extraction view reads
 * it back to tell the screen that this particular `revisar` is repaired by
 * RE-RUNNING rather than by typing (api/services/extraction-service.ts). Both
 * already import this module; a string literal in each is a string literal
 * that drifts.
 */
export const RECALIBRATED_DURING_EXTRACTION = "template recalibrado durante a extração; re-execute";

export interface ExtractJobInput {
  readonly tenantId: string;
  /** The document's own S3 key — the handle every hop uses. Carried even in
   * `text` mode: it is what `extractionRefKey` keys the charge on (§12.6). */
  readonly s3Key: string;
  readonly inputMode: InputMode;
  /** The live extract template's id at enqueue time — half of the staleness
   * check the collector makes before caching. */
  readonly templateId: string;
  /** §12.8's cache-key generation, as it stood when this job was built. */
  readonly calibrationRev: number;
  /** The frozen list, as the tree everything downstream reads (§3.1). */
  readonly fields: readonly FieldSpec[];
  /**
   * The WHOLE document's text, extracted locally (api/detection/page-text.ts
   * `extractDocumentText`). Required for `text` mode — that is what "text
   * mode" MEANS — and ignored for `vision`.
   */
  readonly documentText: string | null;
  readonly provider: string;
  readonly model: string;
  /** §7 — present only for BYOK. The relay reads it and independently
   * re-derives the only path this tenant may name (§12.7); api/billing/charge.ts
   * reads it back off the stored payload to know whose key paid. */
  readonly ssmParamName?: string | undefined;
  /** Shown to the model as context, exactly as the POC did
   * (`Documento: {provider} / {documentType}`). */
  readonly providerName?: string | undefined;
  readonly documentTypeName?: string | undefined;
}

function buildPrompt(input: ExtractJobInput): string {
  const heading =
    input.providerName === undefined && input.documentTypeName === undefined
      ? null
      : `Documento: ${[input.providerName, input.documentTypeName]
          .filter((part): part is string => part !== undefined)
          .join(" / ")}.`;

  const source =
    input.inputMode === "vision"
      ? ["Leia o PDF anexado."]
      : [
          "O texto do documento foi extraído localmente e está abaixo, marcado por página.",
          "Use o marcador [página N] para preencher qualquer campo que peça a página.",
          "---",
          (input.documentText ?? "").slice(0, DOCUMENT_TEXT_BUDGET),
          "---",
        ];

  return [
    ...(heading === null ? [] : [heading, ""]),
    ...source,
    "",
    "Extraia exatamente estes campos:",
    fieldsToPrompt(input.fields),
  ].join("\n");
}

/**
 * The canonical `AiJob` payload (§6), as `Record<string, unknown>` per
 * `enqueueRelayJob`'s own contract — the relay is the authority on whether a
 * payload is a job, and a typed copy here is how the two drift.
 *
 * Throws on the two states that cannot produce a usable job: an empty field
 * list (the runtime Zod schema would be `strictObject({})`, which rejects
 * every document), and `text` mode with no text (the caller must decide
 * whether that is a recalibration or a bad upload — §3.1 forbids this function
 * quietly promoting it to a vision hop).
 */
export function buildExtractJob(input: ExtractJobInput): Record<string, unknown> {
  if (input.fields.length === 0) {
    throw new Error("buildExtractJob: frozen field list is empty");
  }
  if (input.inputMode === "text" && (input.documentText ?? "").trim().length === 0) {
    throw new Error("buildExtractJob: input_mode is 'text' but the document has no text layer");
  }

  return {
    channel: "ai",
    kind: "extract",
    tenantId: input.tenantId,
    provider: input.provider,
    model: input.model,
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(input),
    // §3.1 — `text` mode's whole point is that the model does NOT get the PDF.
    ...(input.inputMode === "vision" ? { document: { s3Key: input.s3Key } } : {}),
    schema: fieldsToJsonSchema(input.fields),
    maxTokens: EXTRACT_MAX_TOKENS,
    ...(input.ssmParamName === undefined ? {} : { ssmParamName: input.ssmParamName }),
    ...billingBinding({ source: "extract", refKey: extractionRefKey(input.s3Key) }),
    // Not read by the relay; read by the collector off `report_jobs.request`.
    [EXTRACT_CONTEXT_KEY]: {
      templateId: input.templateId,
      calibrationRev: input.calibrationRev,
      fields: input.fields,
    },
  };
}

/**
 * The inverse: pull the template binding back out of a stored
 * `report_jobs.request`.
 *
 * Returns `null` for anything that is not one — a job enqueued before this
 * binding existed, a hand-edited row, a payload that is not an object. The
 * collector treats that as `revisar` rather than falling back to a live read,
 * because a live read is exactly the race this exists to close: silently
 * doing the wrong thing is worse than one document waiting for a person.
 *
 * The `fields` are re-validated structurally rather than trusted: they came
 * out of a jsonb column, and `buildZodSchema` would build a nonsense schema
 * (or throw) from a malformed one.
 */
export function readExtractContext(request: unknown): ExtractContext | null {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    return null;
  }
  const raw = (request as Record<string, unknown>)[EXTRACT_CONTEXT_KEY];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const context = raw as Record<string, unknown>;
  const templateId = context["templateId"];
  const calibrationRev = context["calibrationRev"];
  const fields = context["fields"];
  if (typeof templateId !== "string" || templateId.length === 0) {
    return null;
  }
  if (typeof calibrationRev !== "number" || !Number.isInteger(calibrationRev)) {
    return null;
  }
  if (!Array.isArray(fields) || fields.length === 0 || !fields.every(isFieldSpecShape)) {
    return null;
  }
  return { templateId, calibrationRev, fields };
}

/** Structural, not semantic: enough that `buildZodSchema` and `fieldsToPrompt`
 * can walk it. The list was written by `buildExtractJob` from rows the DB
 * CHECK constraint already policed — this guards the jsonb round trip, not the
 * calibration. */
function isFieldSpecShape(value: unknown): value is FieldSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const f = value as Record<string, unknown>;
  if (typeof f["name"] !== "string" || f["name"].length === 0) {
    return false;
  }
  // The TYPE is checked against the vocabulary, not merely against `string`:
  // `buildZodSchema`'s switch has no default branch (it is exhaustive over
  // FieldType by construction), so an unrecognised type would build a shape
  // entry of `undefined` and blow up inside Zod rather than here.
  if (typeof f["type"] !== "string" || !isFieldType(f["type"])) {
    return false;
  }
  if (typeof f["required"] !== "boolean" || typeof f["description"] !== "string") {
    return false;
  }
  const children = f["fields"];
  if (children === undefined) {
    return true;
  }
  return Array.isArray(children) && children.every(isFieldSpecShape);
}
