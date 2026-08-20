// api/collector/extraction-store.ts
//
// The one table the collector writes besides `report_jobs`: `extractions`
// (decisions §4, §12.8).
//
// Hop 1 is cached on the ARTIFACT, not on the job — "three templates over the
// same document = one extraction, three analyses" (§4). The cache key is
// `unique(s3_key, calibration_rev)`, and honouring it with ON CONFLICT DO
// NOTHING is what makes an at-least-once S3 event safe to receive twice: the
// second delivery inserts nothing and says so, rather than raising a constraint
// violation the caller would have to distinguish from a real fault.
//
// The template is RESOLVED here rather than carried on the job row. A job row
// knows its document; the document knows its type; the type has exactly one
// live extract template (`extract_templates_document_type_idx`), and that
// template owns the `calibration_rev` half of the cache key. Copying the rev
// onto the job at enqueue time would freeze a value that §12.8 exists to
// invalidate — a recalibration between enqueue and result would then write the
// new extraction under the OLD rev and the cache would serve it forever.

import { and, eq, isNull } from "drizzle-orm";
import { documents, extractions, extractFields, extractTemplates } from "../../drizzle/schema";
import { buildFieldTree, type FieldSpec } from "../../shared/validation/field-spec";
import type { DbLike } from "./job-state";

/** Everything `extractions` needs that is not in the model's answer. */
export interface ExtractionTarget {
  readonly documentId: string;
  readonly extractTemplateId: string;
  /** Denormalised from `documents.s3_key` — half of the cache key. */
  readonly s3Key: string;
  readonly calibrationRev: number;
}

/**
 * documents → (document_type) → the live extract template, tenant-scoped at
 * every hop.
 *
 * Returns null when the chain is broken: no document row, a document whose type
 * was never detected, or a type whose template has been soft-deleted. That is
 * not a transient failure and it is not the model's fault, so the caller must
 * NOT retry it — another paid extraction would land on the same missing row.
 */
export async function resolveExtractionTarget(
  dbHandle: DbLike,
  tenantId: string,
  documentId: string,
): Promise<ExtractionTarget | null> {
  const rows = await dbHandle
    .select({
      documentId: documents.id,
      s3Key: documents.s3Key,
      extractTemplateId: extractTemplates.id,
      calibrationRev: extractTemplates.calibrationRev,
    })
    .from(documents)
    .innerJoin(
      extractTemplates,
      and(
        eq(extractTemplates.documentTypeId, documents.documentTypeId),
        eq(extractTemplates.tenantId, tenantId),
        isNull(extractTemplates.deletedAt),
      ),
    )
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.tenantId, tenantId),
        isNull(documents.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface ExtractionOrigin {
  readonly provider: string;
  readonly model: string;
}

/**
 * Inserts the validated payload, or does nothing because it is already there.
 *
 * `created: false` is the DUPLICATE, and it is the expected outcome of the
 * second delivery of the same result — the caller treats it as success and goes
 * on to flip the job row, because the artifact this job existed to produce
 * exists.
 *
 * `created_by` / `last_upd_by` stay NULL: no user did this (see job-state.ts).
 */
export async function insertExtractionIdempotent(
  dbHandle: DbLike,
  tenantId: string,
  target: ExtractionTarget,
  data: unknown,
  origin: ExtractionOrigin,
): Promise<{ created: boolean }> {
  const now = new Date().toISOString();
  const inserted = await dbHandle
    .insert(extractions)
    .values({
      tenantId,
      documentId: target.documentId,
      extractTemplateId: target.extractTemplateId,
      s3Key: target.s3Key,
      calibrationRev: target.calibrationRev,
      data,
      provider: origin.provider,
      model: origin.model,
      createdAt: now,
      lastUpdAt: now,
    })
    .onConflictDoNothing({ target: [extractions.s3Key, extractions.calibrationRev] })
    .returning({ id: extractions.id });
  return { created: inserted.length === 1 };
}

/**
 * The frozen field list for a template, as the TREE everything downstream
 * reads (`buildZodSchema`, the extractor prompt, the repair screen).
 *
 * It lives here rather than being reached through
 * api/services/calibration-service.ts's `getTemplate` because the COLLECTOR
 * needs it (§4.2: an extraction is only `done` if it validates against this
 * list) and the collector must not import a tRPC-flavoured service that
 * throws `TRPCError` at a Lambda with no request to answer. Same table, same
 * `buildFieldTree`, no second opinion about ordering or nesting.
 *
 * Tenant-scoped even though `extract_template_id` is already the tenant's:
 * the id arrives from a row this function did not read.
 */
export async function loadTemplateFields(
  dbHandle: DbLike,
  tenantId: string,
  extractTemplateId: string,
): Promise<FieldSpec[]> {
  const rows = await dbHandle
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
        eq(extractFields.extractTemplateId, extractTemplateId),
        eq(extractFields.tenantId, tenantId),
        isNull(extractFields.deletedAt),
      ),
    );
  return buildFieldTree(rows);
}
