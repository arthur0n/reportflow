// api/analysis/analyse-job.ts
//
// Hop 2 (decisions §4): the canonical relay job that writes the `{{ai}}` prose
// for a report. It builds the payload and nothing else — it does not enqueue
// (api/lib/relay.ts does), does not read the result (api/collector/collect.ts
// does), and does not decide which slots need writing
// (api/services/analysis-service.ts does).
//
// PORTED FROM poc/analyse.ts, which proved this prompt shape against a real
// corpus. Three things the POC established, kept verbatim:
//
//   1. §12.3 IS EXPRESSED AS AN ABSENCE. There is no `document` on this
//      payload and no code path here that could put one there. Hop 2 reads the
//      STORED EXTRACTIONS and the code-computed context; it never opens a PDF.
//      A guarantee you can see by reading the object is worth more than one
//      you have to trust a comment about.
//   2. THE MODEL IS HANDED THE FIGURES (§12.12b). "FACTOS APURADOS (já
//      validados e já somados — use estes números EXATAMENTE como aparecem,
//      não recalcule nada)". The aggregates are computed in
//      api/render/report-context.ts, in integer cents, before this job exists.
//      The model writes prose AROUND them and is never the source of a number
//      — which is also exactly what the §12.12c numeral guard then checks.
//   3. THE SLOT DECLARATIONS ARE THE FIELD LIST. Same mechanism as §3.1's
//      frozen list: one declaration becomes the prompt AND the provider schema
//      AND the validator. `guideline` is what the author wrote; `maxWords` is
//      a budget, and the POC allowed 1.6× slack on it because a hard cut mid-
//      sentence is worse prose than a slightly long paragraph.
//
// ONE `analyse` JOB FILLS EVERY PENDING SLOT (§9 — "per-section parallel
// fan-out" is explicitly not in v1). N slots in one call share one system
// prompt and one copy of the facts, which is both cheaper and more coherent:
// the sections are about the same documents and a fan-out would let two of
// them disagree about what they are describing.
//
// WHY `kind: "analyse"` CARRIES A `purpose`. That kind is shared with
// Calibrate (api/calibration/propose-job.ts explains why it is not its own
// kind). The collector has to tell a field-list proposal from a report's prose
// before it merges anything into `content_json`, so this rides the same
// mechanism Calibrate does — a marker in the PAYLOAD, which survives on
// `report_jobs.request` and vanishes at the relay for free.

import type { SlotDeclarationT } from "../../shared/validation/outbound-schemas";
import { billingBinding } from "../billing/charge";

/** The marker that distinguishes a report analysis from a Calibrate proposal
 * on an otherwise identical `analyse` job row. */
export const REPORT_ANALYSIS_PURPOSE = "report";

/** The payload key `AnalysisContext` rides on. Named once so the writer and
 * the reader below cannot disagree about it. */
export const ANALYSIS_CONTEXT_KEY = "reportAnalysis";

/**
 * The facts an analyse job is BOUND to, carried in the payload and therefore
 * surviving on `report_jobs.request`.
 *
 * The same reasoning as `ExtractContext` (api/extraction/extract-job.ts): the
 * collector merges this answer into a report ~30s after it was asked for, and
 * everything that decides HOW to merge it — which report, which slots were in
 * flight, which of them were forced past the §5.2 edited guard — was decided
 * when the job was built. Re-deriving any of it from live rows at merge time
 * is a race with the human editing the draft in the other tab.
 */
export interface AnalysisContext {
  readonly reportId: string;
  /** The version pinned when the job was built (§5.3). A draft upgraded to v2
   * mid-flight must not have v1's prose merged into it. */
  readonly templateVersionId: string;
  /** The slugs this job was asked to fill. Anything else the model returns is
   * discarded — a model that invents a slot is not permitted to create one. */
  readonly slugs: readonly string[];
  /** Slugs the caller explicitly forced past the §5.2 edited guard
   * ("regerar mesmo assim"). A SUBSET of `slugs`. */
  readonly forced: readonly string[];
  /** The bound extractions, for §12.6's ref_id. Sorted at build time. */
  readonly extractionIds: readonly string[];
}

/**
 * §12.6's charge key for this hop, minus the grammar
 * (api/billing/charge.ts `chargeRefId` owns that):
 *
 *   report_analysis:{provider}:{model}:{templateVersionId}:{sortedExtractionIds}
 *
 * IT DOES NOT INCLUDE THE SLUG SET, AND THAT IS THE SPEC. §7 keys the charge
 * on the ARTIFACT, not the job: the artifact here is "this template version's
 * prose about exactly these extractions". A regeneration — including the §5.2
 * "regerar mesmo assim" of a single slot — is therefore FREE, in the same way
 * that re-reading the same PDF is free. That is a real cost the platform
 * absorbs, and it is the same trade §7 already made deliberately for
 * extraction: the alternative bills a user for discovering that an answer was
 * wrong.
 */
export function analysisRefKey(
  templateVersionId: string,
  extractionIds: readonly string[],
): string {
  return `${templateVersionId}:${[...extractionIds].sort().join(",")}`;
}

const SYSTEM_PROMPT = [
  "Você é uma secretária executiva. Escreve com sobriedade, precisão e sem adjetivação comercial.",
  "Nunca inventa números.",
  "Você redige apenas as secções em PROSA de um relatório já montado: nunca layout, nunca uma tabela, nunca um número que o leitor não possa conferir nos factos que lhe foram dados.",
].join("\n");

/**
 * The slot declarations as the provider's structured-output schema.
 *
 * Written out here rather than through `fieldsToJsonSchema` because a slot is
 * not a `FieldSpec`: it has a guideline and a word budget, not a type and a
 * required flag, and borrowing the extraction machinery would mean inventing
 * an `input_mode` for a hop that never sees a document.
 */
export function slotsToJsonSchema(slots: readonly SlotDeclarationT[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const slot of slots) {
    properties[slot.slug] = {
      type: "string",
      description: `${slot.guideline} Máximo ${String(slot.maxWords)} palavras. Texto corrido, sem HTML.`,
    };
  }
  return {
    type: "object",
    properties,
    required: slots.map((s) => s.slug),
    additionalProperties: false,
  };
}

/** Prose shorter than this is not a section. The POC's own floor. */
export const MIN_SLOT_CHARS = 40;

/**
 * Is this one answer usable as this one slot's prose? `null` when it is, an
 * operator-legible reason when it is not.
 *
 * PER SLOT, not one schema over the whole answer, and that is the point: a
 * model that writes four good sections and one two-word stub has produced four
 * usable sections. Rejecting the object would throw all five away and spend
 * §4.2's retry to ask the same model the same question.
 *
 * The three checks are the POC's `slotSchema`, and each one caught something
 * real: prose too short to be a section; HTML smuggled into an `{{ai}}` slot,
 * which §12.4 ESCAPES rather than renders, so the reader would see the tags
 * printed in their report; and a paragraph that blew through the author's word
 * budget and broke the page layout. The 1.6× slack on `maxWords` is the POC's
 * too — a hard cut mid-sentence is worse prose than a slightly long one.
 */
export function slotAnswerProblem(slot: SlotDeclarationT, text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length < MIN_SLOT_CHARS) {
    return `slot "${slot.slug}": prosa curta demais`;
  }
  if (/<[a-z/]/iu.test(trimmed)) {
    return `slot "${slot.slug}": HTML não é permitido em prosa`;
  }
  if (trimmed.split(/\s+/u).length > slot.maxWords * 1.6) {
    return `slot "${slot.slug}": excede o limite de palavras`;
  }
  return null;
}

export interface AnalysisJobInput {
  readonly tenantId: string;
  readonly reportId: string;
  readonly templateVersionId: string;
  /** ONLY the slots this job must fill. The caller has already applied §5.2. */
  readonly slots: readonly SlotDeclarationT[];
  readonly forced: readonly string[];
  /** `buildReportContext(...).context` — meta, the extractions BY ROLE, and
   * the code-computed `totais` (§12.12b). */
  readonly context: Record<string, unknown>;
  readonly extractionIds: readonly string[];
  readonly provider: string;
  readonly model: string;
  /** §7 — present only for BYOK. See credentials-service `keyBinding`. */
  readonly ssmParamName?: string | undefined;
}

/**
 * Output budget. Scales with what was actually asked for rather than being one
 * constant for a 1-slot regeneration and a 24-slot first pass alike: ~3 tokens
 * per pt-BR word, the POC's 1.6× overshoot slack folded in, plus room for the
 * JSON wrapper. Capped well under relay/src/job.ts's own ceiling.
 */
export function analysisMaxTokens(slots: readonly SlotDeclarationT[]): number {
  const words = slots.reduce((sum, slot) => sum + slot.maxWords, 0);
  return Math.min(32_768, Math.max(2_048, 512 + Math.ceil(words * 1.6 * 3)));
}

function buildPrompt(input: AnalysisJobInput): string {
  return [
    "Você redige as secções em prosa de um relatório destinado ao cliente final.",
    "",
    "FACTOS APURADOS (já validados e já somados — use estes números EXATAMENTE como aparecem, não recalcule nada):",
    JSON.stringify(input.context, null, 2),
    "",
    "Escreva os campos pedidos. Restrições absolutas:",
    "- Nenhum número que não conste dos factos acima.",
    "- Nenhuma data que não conste dos factos acima.",
    "- Nenhuma projeção, estimativa ou cenário.",
    "- Texto corrido, sem HTML, sem marcadores, sem títulos.",
    "- Português do Brasil, registo formal.",
    "",
    "Secções a escrever:",
    ...input.slots.map(
      (slot) =>
        `- ${slot.slug}: ${slot.guideline.length > 0 ? slot.guideline : "(sem orientação; escreva a secção pelo nome do slot)"} Máximo ${String(slot.maxWords)} palavras.`,
    ),
  ].join("\n");
}

/**
 * The canonical `AiJob` payload (§6), as `Record<string, unknown>` per
 * `enqueueRelayJob`'s own contract — the relay is the authority on whether a
 * payload is a job, and a typed copy here is how the two drift.
 *
 * Throws on the one state that cannot produce a usable job: no slots. A
 * `strictObject({})` schema would ask the model for nothing and bill for the
 * asking.
 */
export function buildAnalysisJob(input: AnalysisJobInput): Record<string, unknown> {
  if (input.slots.length === 0) {
    throw new Error("buildAnalysisJob: no slots to fill");
  }
  const extractionIds = [...input.extractionIds].sort();

  return {
    channel: "ai",
    kind: "analyse",
    purpose: REPORT_ANALYSIS_PURPOSE,
    tenantId: input.tenantId,
    provider: input.provider,
    model: input.model,
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(input),
    // NO `document`. That is the §12.3 guarantee, expressed as an absence.
    schema: slotsToJsonSchema(input.slots),
    maxTokens: analysisMaxTokens(input.slots),
    ...(input.ssmParamName === undefined ? {} : { ssmParamName: input.ssmParamName }),
    ...billingBinding({
      source: "analyse",
      refKey: analysisRefKey(input.templateVersionId, extractionIds),
    }),
    // Not read by the relay; read by the collector off `report_jobs.request`.
    [ANALYSIS_CONTEXT_KEY]: {
      reportId: input.reportId,
      templateVersionId: input.templateVersionId,
      slugs: input.slots.map((s) => s.slug),
      forced: input.forced,
      extractionIds,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      return null;
    }
    out.push(item);
  }
  return out;
}

/**
 * The inverse: pull the binding back out of a stored `report_jobs.request`.
 *
 * `null` for anything that is not one — a Calibrate proposal, a job enqueued
 * before this binding existed, a hand-edited row. The collector then treats
 * the job as "the result IS the artifact" and settles it without merging,
 * which is exactly what it did for every `analyse` job before #10: the answer
 * survives verbatim on `report_jobs.result` and nothing is silently written
 * into somebody's draft.
 */
export function readAnalysisContext(request: unknown): AnalysisContext | null {
  const payload = asRecord(request);
  if (payload?.["purpose"] !== REPORT_ANALYSIS_PURPOSE) {
    return null;
  }
  const raw = asRecord(payload[ANALYSIS_CONTEXT_KEY]);
  if (raw === null) {
    return null;
  }
  const reportId = raw["reportId"];
  const templateVersionId = raw["templateVersionId"];
  const slugs = asStringArray(raw["slugs"]);
  const forced = asStringArray(raw["forced"]) ?? [];
  const extractionIds = asStringArray(raw["extractionIds"]) ?? [];
  if (typeof reportId !== "string" || reportId.length === 0) {
    return null;
  }
  if (typeof templateVersionId !== "string" || templateVersionId.length === 0) {
    return null;
  }
  if (slugs === null || slugs.length === 0) {
    return null;
  }
  return { reportId, templateVersionId, slugs, forced, extractionIds };
}
