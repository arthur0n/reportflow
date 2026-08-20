// api/detection/classify-job.ts
//
// Tier 2 of document type detection (decisions §3.3, §12.2): "one cheap hop,
// only when no hint matches". This file builds the CANONICAL relay job
// payload (relay/src/job.ts `AiJob`) for that hop — it does not enqueue it
// (api/lib/relay.ts `enqueueRelayJob` does that) and does not read the
// result (the `detect` router mutation + the collector do).
//
// The job classifies FROM THE PDF ITSELF via the relay (§12.2) — tier 2 only
// runs when tier 1 (page-1 text substring match) found nothing to work with,
// which includes the scanned-with-no-text-layer case, so a job built here
// must not assume page text exists.
//
// Provider/model are ARGUMENTS, not constants (#10). §6 puts model choice at
// the account level and this hop is the trivial one — the platform default
// lives in api/services/credentials-service.ts (`PLATFORM_DEFAULTS.detect`),
// which is also where BYOK key ownership is resolved (§7, §12.7). This file
// does not know whose key pays and has no reason to.

import { eq, and, isNull } from "drizzle-orm";
import { documentTypes, extractTemplates, providers } from "../../drizzle/schema";
import { billingBinding } from "../billing/charge";
import type { DbLike } from "../collector/job-state";

/** A document type the model may pick from, plus the tier-1 hints (if any) —
 * shown to the model as a hint of its own, not matched programmatically. */
export interface ClassifiableType {
  readonly documentTypeId: string;
  /** `"{provider} / {name}"` — see `labelFor`. Disambiguates two providers
   * that happen to use the same type name (`document_types` is unique on
   * `(provider_id, name)`, not on `name` alone, so the bare name can collide
   * within one tenant). */
  readonly label: string;
  readonly hints: readonly string[];
}

function labelFor(providerName: string, typeName: string): string {
  return `${providerName} / ${typeName}`;
}

/** The catch-all the model must use when nothing on the list fits — the
 * schema's enum always carries it, so "none of these" is an answer the
 * schema can express instead of forcing a bad guess. */
export const UNKNOWN_TYPE_LABEL = "desconhecido";

/**
 * Every active document type the tenant has configured, labelled and paired
 * with its `detect_hint` list (empty when Calibrate has not set one) —
 * everything tier 1 already knows, handed to the model as extra context
 * rather than programmatically matched.
 *
 * Deliberately wider than `detect.ts`'s `loadHintCandidates`: a type with NO
 * hint configured yet is still something the model can classify by name and
 * general shape, so it belongs on tier 2's menu even though tier 1 would
 * never consider it a candidate.
 */
export async function loadClassifiableTypes(
  dbHandle: DbLike,
  tenantId: string,
): Promise<ClassifiableType[]> {
  const rows = await dbHandle
    .select({
      documentTypeId: documentTypes.id,
      typeName: documentTypes.name,
      providerName: providers.name,
      detectHint: extractTemplates.detectHint,
    })
    .from(documentTypes)
    .innerJoin(
      providers,
      and(eq(providers.id, documentTypes.providerId), isNull(providers.deletedAt)),
    )
    // LEFT: a document type with no live extract template yet still belongs
    // on the classification menu (Calibrate may not have run for it), it
    // simply carries no hints.
    .leftJoin(
      extractTemplates,
      and(
        eq(extractTemplates.documentTypeId, documentTypes.id),
        eq(extractTemplates.tenantId, tenantId),
        isNull(extractTemplates.deletedAt),
      ),
    )
    .where(and(eq(documentTypes.tenantId, tenantId), isNull(documentTypes.deletedAt)));

  return rows.map((r) => ({
    documentTypeId: r.documentTypeId,
    label: labelFor(r.providerName, r.typeName),
    hints: Array.isArray(r.detectHint) ? (r.detectHint as string[]) : [],
  }));
}

const SYSTEM_PROMPT =
  "Você classifica o tipo de um documento a partir do PDF anexado. Responda " +
  "apenas com o tipo mais provável dentre as opções fornecidas. Se nenhuma " +
  `opção corresponder com confiança, responda "${UNKNOWN_TYPE_LABEL}". Nunca ` +
  "invente um tipo fora da lista.";

function buildPrompt(types: readonly ClassifiableType[]): string {
  const lines = types.map((t) => {
    const hintNote = t.hints.length > 0 ? ` (pistas conhecidas: ${t.hints.join(", ")})` : "";
    return `- ${t.label}${hintNote}`;
  });
  return [
    "Qual destes tipos de documento é o PDF anexado?",
    "",
    ...lines,
    "",
    `Se não tiver certeza, responda "${UNKNOWN_TYPE_LABEL}".`,
  ].join("\n");
}

function buildSchema(types: readonly ClassifiableType[]): Record<string, unknown> {
  const enumValues = [...types.map((t) => t.label), UNKNOWN_TYPE_LABEL];
  return {
    type: "object",
    properties: {
      document_type: { type: "string", enum: enumValues },
    },
    required: ["document_type"],
  };
}

/** Small: the answer is one enum value, never prose (§6.2's cost budget has
 * no room for a classification hop to run away). */
const DETECT_MAX_TOKENS = 256;

/**
 * §12.6's charge key for this hop, minus the grammar
 * (api/billing/charge.ts `chargeRefId` owns that):
 *
 *     report_detect:{provider}:{model}:{s3Key}
 *
 * §7 named three prefixes and not this one. It gets the same grammar for the
 * same reason the others have it: a hop that runs is a hop that is billed, and
 * one keyed on the document means classifying the same PDF twice — which is
 * what a stale `detect_hint` and a corrected dropdown both cause — costs the
 * customer once.
 */
export function detectRefKey(s3Key: string): string {
  return s3Key;
}

export interface DetectJobInput {
  readonly tenantId: string;
  /** The document's own S3 key — the API reads it back via `document.s3Key`
   * the same way every other hop does; there is no separate upload here. */
  readonly s3Key: string;
  readonly types: readonly ClassifiableType[];
  readonly provider: string;
  readonly model: string;
  /** §7 — present only for BYOK. */
  readonly ssmParamName?: string | undefined;
}

export interface DetectJobBuild {
  /** The canonical `AiJob`-shaped payload (`Record<string,unknown>` per
   * `enqueueRelayJob`'s own contract — see api/lib/relay.ts). */
  readonly payload: Record<string, unknown>;
  /** The model's enum label → documentTypeId, for the router to resolve the
   * relay's answer once the job comes back (`applyDetection`). */
  readonly labelToDocumentTypeId: ReadonlyMap<string, string>;
}

/**
 * Builds the tier-2 `detect` job payload and the label→id map needed to
 * resolve its answer. Throws if `types` is empty — a tenant with zero
 * document types configured has nothing for the model to choose between, and
 * enqueuing a job whose schema enum is just `["desconhecido"]` would spend
 * money to learn a fact the caller already knows.
 */
export function buildDetectJob(input: DetectJobInput): DetectJobBuild {
  if (input.types.length === 0) {
    throw new Error("buildDetectJob: tenant has no document types to classify against");
  }

  const labelToDocumentTypeId = new Map(input.types.map((t) => [t.label, t.documentTypeId]));

  const payload: Record<string, unknown> = {
    channel: "ai",
    kind: "detect",
    tenantId: input.tenantId,
    provider: input.provider,
    model: input.model,
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(input.types),
    document: { s3Key: input.s3Key },
    schema: buildSchema(input.types),
    maxTokens: DETECT_MAX_TOKENS,
    ...(input.ssmParamName === undefined ? {} : { ssmParamName: input.ssmParamName }),
    ...billingBinding({ source: "detect", refKey: detectRefKey(input.s3Key) }),
  };

  return { payload, labelToDocumentTypeId };
}
