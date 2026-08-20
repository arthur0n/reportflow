// api/services/calibration-service.ts
//
// Calibrate (decisions §3.1, §3.3, §12.8): "upload a sample → AI proposes →
// human edits → FROZEN", the core §4 pattern in the one place where the human
// is not optional.
//
// Three moves, and the split between them is the design:
//
//   propose            — enqueues ONE relay hop against the sample PDF and
//                        returns the `report_jobs.id` the client already knows
//                        how to poll. Writes a job row and nothing else.
//   interpretProposal  — turns a settled job row into a DRAFT. Stores NOTHING.
//                        §3.1's human step is not a formality: a proposal that
//                        silently became a template would make the frozen list
//                        a model's opinion, and every later extraction would
//                        inherit it unattended.
//   freeze             — lives in ./calibration-freeze.ts (this file would
//                        otherwise be over the 500-line limit). It is the only
//                        writer of the input axis and of the golden fixture,
//                        and it re-proves every id the client sent against the
//                        caller's own tenant before writing anything.
//
// `loadOwnedDocument` / `loadOwnedProviderName` are exported for that file:
// ownership is re-proven the same way on both sides of the split, from one
// implementation.

import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  documentTypes,
  documents,
  extractFields,
  extractTemplates,
  providers,
  reportJobs,
} from "../../drizzle/schema";
import type { DbLike, JobRow } from "../collector/job-state";
import { withSystemFields } from "../db/scope";
import { parseModelJson } from "../collector/relay-result";
import { extractPageOneText } from "../detection/page-text";
import { buildCalibrateJob, isCalibrateRequest } from "../calibration/propose-job";
import { jobKeyFor, mintJobId } from "../lib/relay";
import { keyBinding, resolveModel } from "./credentials-service";
import { buildFieldTree, type FieldSpec, type InputMode } from "../../shared/validation/field-spec";
import {
  CalibrationProposalZ,
  type ProposeCalibrationInputT,
} from "../../shared/validation/calibration-schemas";

export interface CalibrationDeps {
  readonly db: DbLike;
  readonly enqueue: (
    tenantId: string,
    jobId: string,
    payload: Record<string, unknown>,
  ) => Promise<void>;
  /** `null` when the object is missing — api/lib/storage.ts's null-on-404
   * convention, mirrored by detection-service.ts. */
  readonly fetchPdf: (s3Key: string) => Promise<Buffer | null>;
}

export interface CalibrationCtx {
  readonly tenantId: string;
  readonly userId: string;
}

// ---------------------------------------------------------------------------
// Ownership. Every id below arrives from the browser; each is a LOOKUP KEY,
// never a permission (the same rule documents-crud.ts states for its FKs).
// ---------------------------------------------------------------------------

export async function loadOwnedDocument(
  dbHandle: DbLike,
  tenantId: string,
  documentId: string,
): Promise<{ readonly id: string; readonly s3Key: string }> {
  const rows = await dbHandle
    .select({ id: documents.id, s3Key: documents.s3Key })
    .from(documents)
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.tenantId, tenantId),
        isNull(documents.deletedAt),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Documento não encontrado." });
  }
  return row;
}

export async function loadOwnedProviderName(
  dbHandle: DbLike,
  tenantId: string,
  providerId: string,
): Promise<string> {
  const rows = await dbHandle
    .select({ name: providers.name })
    .from(providers)
    .where(
      and(
        eq(providers.id, providerId),
        eq(providers.tenantId, tenantId),
        isNull(providers.deletedAt),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Fornecedor inválido." });
  }
  return row.name;
}

// ---------------------------------------------------------------------------
// propose — one relay hop, no writes but the job row
// ---------------------------------------------------------------------------

/**
 * Enqueues the proposal hop and hands back `report_jobs.id`.
 *
 * The page-1 text is extracted HERE, locally and for free
 * (api/detection/page-text.ts), and handed to the model rather than left for
 * it to infer: `input_mode` is a cost decision whose deciding fact we can
 * establish without paying anyone (§3.1), and `detect_hint` candidates have
 * to be substrings of THIS extraction or tier 1 will never match them (§3.3).
 *
 * ORDER IS THE SAME AS EVERY OTHER ENQUEUE PATH: the `report_jobs` row is
 * committed BEFORE the S3 PutObject (api/collector/collect.ts's requirement),
 * so a fast relay cannot produce a result for a row nobody can see yet.
 */
export async function proposeCalibration(
  deps: CalibrationDeps,
  ctx: CalibrationCtx,
  input: ProposeCalibrationInputT,
): Promise<{ readonly jobId: string }> {
  const doc = await loadOwnedDocument(deps.db, ctx.tenantId, input.documentId);
  const providerName =
    input.providerId === undefined
      ? undefined
      : await loadOwnedProviderName(deps.db, ctx.tenantId, input.providerId);

  const bytes = await deps.fetchPdf(doc.s3Key);
  const pageOneText = bytes === null ? null : await extractPageOneText(bytes);

  // §6/§7 — the account's model and whose key pays (§10.5 refuses an unpriced
  // platform-key hop here, before any money is spent).
  const resolved = await resolveModel(deps.db, ctx.tenantId, "calibrate");
  const payload = buildCalibrateJob({
    tenantId: ctx.tenantId,
    s3Key: doc.s3Key,
    providerName,
    documentTypeName: input.documentTypeName,
    pageOneText,
    provider: resolved.provider,
    model: resolved.model,
    ...keyBinding(resolved),
  });

  const jobId = mintJobId();
  const stamped = withSystemFields({ userId: ctx.userId }, "create", {
    tenantId: ctx.tenantId,
    kind: "analyse",
    status: "pending",
    s3Key: jobKeyFor(ctx.tenantId, jobId),
    attempt: 1,
    request: payload,
    documentId: doc.id,
  });

  const inserted = await deps.db.insert(reportJobs).values(stamped).returning();
  const row = inserted[0];
  if (row === undefined) {
    throw new Error("proposeCalibration: report_jobs insert returned no row");
  }

  await deps.enqueue(ctx.tenantId, jobId, payload);

  return { jobId: row.id };
}

// ---------------------------------------------------------------------------
// interpretProposal — a settled job row → a draft a human can edit
// ---------------------------------------------------------------------------

export interface CalibrationProposal {
  readonly documentTypeName: string;
  readonly inputMode: InputMode;
  readonly detectHint: readonly string[];
  readonly fields: readonly FieldSpec[];
  /** The model's reading of the sample, pretty-printed for the textarea the
   * human confirms it in. `null` when the model did not return one, or
   * returned something that is not a JSON object. */
  readonly sampleValuesJson: string | null;
}

export type ProposalOutcome =
  | { readonly status: "pending" }
  | { readonly status: "ready"; readonly proposal: CalibrationProposal }
  /** The hop failed (relay error, retries exhausted). `error` is the job's own. */
  | { readonly status: "failed"; readonly error: string }
  /** The hop succeeded but the answer is not a proposal — bad JSON, or a shape
   * `CalibrationProposalZ` refuses. Distinct from `failed` because the money is
   * spent either way but only this one is worth re-running. */
  | { readonly status: "unreadable"; readonly error: string };

/** Pretty-print a JSON object string, or `null` if it is not one. Anything the
 * model wrapped in prose, or an array, is not a fixture. */
function normaliseSampleValues(raw: string | undefined): string | null {
  if (raw === undefined) {
    return null;
  }
  const parsed = parseModelJson(raw);
  return parsed.ok ? JSON.stringify(parsed.data, null, 2) : null;
}

function readEnvelopeContent(result: unknown): string | null {
  if (typeof result !== "object" || result === null) {
    return null;
  }
  const content = (result as Record<string, unknown>)["content"];
  return typeof content === "string" ? content : null;
}

/**
 * Maps a polled job row onto a proposal outcome. PURE — it stores nothing,
 * which is the §3.1 human step made structural rather than remembered.
 *
 * Refuses a row that is not a Calibrate proposal: `analyse` is a shared kind
 * (see api/calibration/propose-job.ts on why), so "this job id is mine" is not
 * the same question as "this job is a proposal", and answering the second with
 * the first would let a report analysis be read as a field list.
 */
export function interpretProposalJob(row: JobRow): ProposalOutcome {
  if (row.kind !== "analyse" || !isCalibrateRequest(row.request)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Trabalho não é uma proposta de calibração.",
    });
  }
  if (row.status === "pending") {
    return { status: "pending" };
  }
  if (row.status !== "done") {
    return { status: "failed", error: row.error ?? "A proposta falhou." };
  }

  const content = readEnvelopeContent(row.result);
  if (content === null) {
    return { status: "unreadable", error: "O modelo não devolveu conteúdo legível." };
  }
  const parsed = parseModelJson(content);
  if (!parsed.ok) {
    return { status: "unreadable", error: parsed.message };
  }
  const proposal = CalibrationProposalZ.safeParse(parsed.data);
  if (!proposal.success) {
    return { status: "unreadable", error: "A proposta não tem o formato esperado." };
  }

  const data = proposal.data;
  return {
    status: "ready",
    proposal: {
      documentTypeName: data.document_type_name,
      inputMode: data.input_mode,
      detectHint: data.detect_hint,
      fields: data.fields.map((f) => ({
        name: f.name,
        type: f.type,
        required: f.required,
        description: f.description,
        ...(f.fields === undefined ? {} : { fields: f.fields }),
      })),
      sampleValuesJson: normaliseSampleValues(data.sample_values_json),
    },
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listProviders(
  dbHandle: DbLike,
  tenantId: string,
): Promise<{ id: string; name: string }[]> {
  return dbHandle
    .select({ id: providers.id, name: providers.name })
    .from(providers)
    .where(and(eq(providers.tenantId, tenantId), isNull(providers.deletedAt)))
    .orderBy(providers.name);
}

export interface TemplateSummary {
  readonly id: string;
  readonly documentTypeId: string;
  readonly providerName: string;
  readonly typeName: string;
  readonly inputMode: string;
  readonly detectHint: readonly string[];
  readonly calibrationRev: number;
  readonly fixtureS3Key: string | null;
  readonly lastUpdAt: string;
}

/** Every frozen template this tenant owns, labelled the way tier 2 and tier 3
 * label a document type (`"{provider} / {name}"`). */
export async function listTemplates(
  dbHandle: DbLike,
  tenantId: string,
): Promise<TemplateSummary[]> {
  const rows = await dbHandle
    .select({
      id: extractTemplates.id,
      documentTypeId: documentTypes.id,
      providerName: providers.name,
      typeName: documentTypes.name,
      inputMode: extractTemplates.inputMode,
      detectHint: extractTemplates.detectHint,
      calibrationRev: extractTemplates.calibrationRev,
      fixtureS3Key: extractTemplates.fixtureS3Key,
      lastUpdAt: extractTemplates.lastUpdAt,
    })
    .from(extractTemplates)
    .innerJoin(documentTypes, eq(documentTypes.id, extractTemplates.documentTypeId))
    .innerJoin(providers, eq(providers.id, documentTypes.providerId))
    .where(and(eq(extractTemplates.tenantId, tenantId), isNull(extractTemplates.deletedAt)))
    .orderBy(desc(extractTemplates.lastUpdAt));

  return rows.map((r) => ({
    ...r,
    detectHint: Array.isArray(r.detectHint) ? (r.detectHint as string[]) : [],
  }));
}

export interface TemplateDetail {
  readonly id: string;
  readonly documentTypeId: string;
  readonly providerName: string;
  readonly typeName: string;
  readonly inputMode: string;
  readonly detectHint: readonly string[];
  readonly calibrationRev: number;
  readonly fixtureS3Key: string | null;
  readonly fields: readonly FieldSpec[];
}

/** One template with its field list as the TREE everything downstream reads —
 * `buildZodSchema`, the extractor prompt, and the authoring table all take the
 * same shape, which is what stops `parent_field_id` from leaking outward. */
export async function getTemplate(
  dbHandle: DbLike,
  tenantId: string,
  templateId: string,
): Promise<TemplateDetail> {
  const rows = await dbHandle
    .select({
      id: extractTemplates.id,
      documentTypeId: documentTypes.id,
      providerName: providers.name,
      typeName: documentTypes.name,
      inputMode: extractTemplates.inputMode,
      detectHint: extractTemplates.detectHint,
      calibrationRev: extractTemplates.calibrationRev,
      fixtureS3Key: extractTemplates.fixtureS3Key,
    })
    .from(extractTemplates)
    .innerJoin(documentTypes, eq(documentTypes.id, extractTemplates.documentTypeId))
    .innerJoin(providers, eq(providers.id, documentTypes.providerId))
    .where(
      and(
        eq(extractTemplates.id, templateId),
        eq(extractTemplates.tenantId, tenantId),
        isNull(extractTemplates.deletedAt),
      ),
    )
    .limit(1);

  const template = rows[0];
  if (template === undefined) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Template de extração não encontrado." });
  }

  const fieldRows = await dbHandle
    .select({
      id: extractFields.id,
      parentFieldId: extractFields.parentFieldId,
      name: extractFields.name,
      type: extractFields.type,
      required: extractFields.required,
      description: extractFields.description,
      sortOrder: extractFields.sortOrder,
    })
    .from(extractFields)
    .where(
      and(
        eq(extractFields.extractTemplateId, templateId),
        eq(extractFields.tenantId, tenantId),
        isNull(extractFields.deletedAt),
      ),
    );

  return {
    ...template,
    detectHint: Array.isArray(template.detectHint) ? (template.detectHint as string[]) : [],
    fields: buildFieldTree(fieldRows),
  };
}
