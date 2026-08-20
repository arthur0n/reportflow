// api/services/detection-service.ts
//
// Orchestrates decisions §3.3's three tiers behind the `documents.detect` /
// `applyDetection` / `setDocumentType` mutations. DB-touching and S3-touching
// logic lives here, not in the router, same split as
// api/services/documents-crud.ts — the router stays thin, this file is what
// gets unit-tested against a fake db/S3/enqueue.
//
// TIER 1 IS SYNCHRONOUS. It costs one S3 read and a local parse, no relay hop,
// so `runDetection` pays that cost inline and returns the final answer. TIER 2
// is a relay round trip: `runDetection` enqueues a `detect` job and hands back
// the `report_jobs.id` the client already knows how to poll (`jobs.poll`) —
// nothing new on the client side. TIER 3 (the dropdown) has no server-side
// state of its own; it is just `setDocumentType`, reachable regardless of what
// tiers 1/2 answered, because §3.3 requires the detected type to be "always
// shown and always correctable".

import { TRPCError } from "@trpc/server";
import { and, eq, isNull, sql } from "drizzle-orm";
import { documents, reportJobs } from "../../drizzle/schema";
import type { DbLike } from "../collector/job-state";
import { withSystemFields } from "../db/scope";
import { assertReferencesOwnedByTenant } from "./documents-crud";
import { extractPageOneText } from "../detection/page-text";
import { detectDocumentType } from "../detection/detect";
import {
  buildDetectJob,
  loadClassifiableTypes,
  UNKNOWN_TYPE_LABEL,
} from "../detection/classify-job";
import { jobKeyFor, mintJobId } from "../lib/relay";
import { keyBinding, resolveModel } from "./credentials-service";
import { parseModelJson } from "../collector/relay-result";

export interface DetectionDeps {
  readonly db: DbLike;
  readonly enqueue: (
    tenantId: string,
    jobId: string,
    payload: Record<string, unknown>,
  ) => Promise<void>;
  /** `null` when the object is missing — mirrors api/lib/storage.ts's own
   * head/get null-on-404 convention. */
  readonly fetchPdf: (s3Key: string) => Promise<Buffer | null>;
}

export type DetectOutcome =
  /** Tier 1 hit — `documents.document_type_id` is already updated. */
  | { readonly outcome: "hint"; readonly documentTypeId: string }
  /** Tier 1 missed; tier 2 enqueued (or an already-pending job for this
   * document was reused — see `loadPendingDetectJob`). `jobId` is
   * `report_jobs.id` — poll it with the SAME `jobs.poll` the rest of the
   * pipeline already uses. */
  | { readonly outcome: "job"; readonly jobId: string }
  /** Tier 1 missed and there is nothing configured for tier 2 to classify
   * against — the tenant has zero document types. Only tier 3 (the dropdown,
   * `setDocumentType`) can resolve this document. */
  | { readonly outcome: "none" }
  /** A human already picked a type while this call was running (a race
   * between `detect` and `setDocumentType`) — the manual choice stands. */
  | { readonly outcome: "skipped-manual" };

async function loadOwnedDocument(
  dbHandle: DbLike,
  tenantId: string,
  documentId: string,
): Promise<typeof documents.$inferSelect | undefined> {
  const rows = await dbHandle
    .select()
    .from(documents)
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.tenantId, tenantId),
        isNull(documents.deletedAt),
      ),
    )
    .limit(1);
  return rows[0];
}

/**
 * Runs tier 1 inline; falls through to enqueueing tier 2 when it misses.
 * Ownership of `documentId` is re-proven against `tenantId` before anything
 * else runs (project_conventions' tenancy rule — every write re-checks it,
 * never trusts a caller's own id).
 */
export async function runDetection(
  deps: DetectionDeps,
  ctx: { readonly tenantId: string; readonly userId: string },
  documentId: string,
): Promise<DetectOutcome> {
  const doc = await loadOwnedDocument(deps.db, ctx.tenantId, documentId);
  if (doc === undefined) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Documento não encontrado." });
  }

  // Tier 1 (§3.3, §12.2): download the PDF once, extract page 1 locally, no
  // internet and no relay hop. A scan with no text layer (or an unreadable
  // object) simply yields `pageText === null` — tier 1 has nothing to match
  // and detectDocumentType treats that identically to a miss.
  const bytes = await deps.fetchPdf(doc.s3Key);
  const pageText = bytes === null ? null : await extractPageOneText(bytes);

  const tier1 = await detectDocumentType(deps.db, ctx.tenantId, pageText);
  if (tier1 !== null) {
    const applied = await applyDetectedType(deps.db, ctx, documentId, tier1.documentTypeId, "hint");
    if (!applied) {
      // Manual always wins (codex review, 2026-08-20): a human called
      // setDocumentType between this call starting and tier 1 finishing.
      return { outcome: "skipped-manual" };
    }
    return { outcome: "hint", documentTypeId: tier1.documentTypeId };
  }

  // Tier 2: one cheap relay hop, classifying from the PDF itself (§12.2) —
  // deliberately not from `pageText`, which may not exist at all.

  // Dedupe BEFORE loading types or building a job: a second `detect` call
  // while one is already in flight for this document (a double-click, a
  // retried request) must reuse that job rather than paying for another
  // classification hop (codex review, 2026-08-20).
  const pending = await loadPendingDetectJob(deps.db, ctx.tenantId, documentId);
  if (pending !== undefined) {
    return { outcome: "job", jobId: pending.id };
  }

  const types = await loadClassifiableTypes(deps.db, ctx.tenantId);
  if (types.length === 0) {
    return { outcome: "none" };
  }

  // §6/§7 — the account's model and whose key pays (§10.5 refuses an unpriced
  // platform-key hop here, before any money is spent).
  const resolved = await resolveModel(deps.db, ctx.tenantId, "detect");
  const { payload } = buildDetectJob({
    tenantId: ctx.tenantId,
    s3Key: doc.s3Key,
    types,
    provider: resolved.provider,
    model: resolved.model,
    ...keyBinding(resolved),
  });
  const jobId = mintJobId();
  const s3Key = jobKeyFor(ctx.tenantId, jobId);
  const stamped = withSystemFields({ userId: ctx.userId }, "create", {
    tenantId: ctx.tenantId,
    kind: "detect",
    status: "pending",
    s3Key,
    attempt: 1,
    request: payload,
    documentId,
  });

  const inserted = await deps.db.insert(reportJobs).values(stamped).returning();
  const row = inserted[0];
  if (row === undefined) {
    throw new Error("runDetection: report_jobs insert returned no row");
  }

  // Point the document at THIS job before it can possibly resolve — the
  // currency guard `applyDetectionResult` checks (`job.id ===
  // documents.detect_job_id`) only works if this is set before the job can
  // finish, and it must land before the S3 PutObject below for the same
  // reason the job row itself must (codex review, 2026-08-20): a fast relay
  // must never be able to resolve against a document that doesn't yet know
  // this is its current job.
  await stampDetectJobId(deps.db, ctx.tenantId, documentId, row.id);

  // COMMIT THE ROW BEFORE PUTOBJECT (api/collector/collect.ts's own
  // requirement on every enqueue path): a fast relay producing a result
  // before this row is visible to a query is dropped by the collector as
  // "no-job-row" rather than crashing, but committing first is what makes
  // that the RARE case instead of the common one.
  await deps.enqueue(ctx.tenantId, jobId, payload);

  return { outcome: "job", jobId: row.id };
}

/** The tenant's already-pending `detect` job for this document, if any
 * (codex review, 2026-08-20) — the dedupe check `runDetection` makes before
 * building a second one. */
async function loadPendingDetectJob(
  dbHandle: DbLike,
  tenantId: string,
  documentId: string,
): Promise<{ readonly id: string } | undefined> {
  const rows = await dbHandle
    .select({ id: reportJobs.id })
    .from(reportJobs)
    .where(
      and(
        eq(reportJobs.tenantId, tenantId),
        eq(reportJobs.documentId, documentId),
        eq(reportJobs.kind, "detect"),
        eq(reportJobs.status, "pending"),
      ),
    )
    .limit(1);
  return rows[0];
}

/** Stamps `documents.detect_job_id` — the currency guard `applyDetectionResult`
 * checks before applying a job's result. A tiny helper only so `runDetection`
 * doesn't repeat the `withSystemFields` boilerplate at its one call site. */
async function stampDetectJobId(
  dbHandle: DbLike,
  tenantId: string,
  documentId: string,
  reportJobId: string,
): Promise<void> {
  await dbHandle
    .update(documents)
    .set({ detectJobId: reportJobId, lastUpdAt: new Date().toISOString() })
    .where(and(eq(documents.id, documentId), eq(documents.tenantId, tenantId)));
}

/**
 * Applies a resolved type to a document — the ONE write both tier 1 (`hint`)
 * and a resolved tier-2 job (`model`) go through.
 *
 * THE WRITE ITSELF IS THE GUARD (codex review, 2026-08-20): `detected_by IS
 * DISTINCT FROM 'manual'` is part of the WHERE clause, not a separate read
 * beforehand — a read-then-write has a window between the two where
 * `setDocumentType` can land and get silently overwritten. `IS DISTINCT FROM`
 * rather than `<>`/`ne()` because SQL's `<>` against a NULL `detected_by`
 * (never detected yet) evaluates to NULL, which would exclude every
 * undetected row from ever being matched — `IS DISTINCT FROM` is NULL-safe.
 *
 * Also clears `detect_job_id` to `null`: whatever job WAS tracked for this
 * document (if any) is superseded by this newer answer the instant it lands,
 * so a stale job's later resolution has nothing left to match
 * (`applyDetectionResult`'s currency guard).
 *
 * Returns whether the write actually landed — `false` means a manual
 * selection already won the race, and callers report `skipped-manual`
 * instead of a false "applied".
 */
async function applyDetectedType(
  dbHandle: DbLike,
  ctx: { readonly tenantId: string; readonly userId: string },
  documentId: string,
  documentTypeId: string,
  detectedBy: "hint" | "model" | "manual",
): Promise<boolean> {
  const rows = await dbHandle
    .update(documents)
    .set(
      withSystemFields({ userId: ctx.userId }, "update", {
        documentTypeId,
        detectedBy,
        detectJobId: null,
      }),
    )
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.tenantId, ctx.tenantId),
        sql`${documents.detectedBy} IS DISTINCT FROM 'manual'`,
      ),
    )
    .returning({ id: documents.id });
  return rows.length === 1;
}

export type ApplyDetectionOutcome =
  /** The model's answer matched a configured type; the document is updated. */
  | { readonly outcome: "applied"; readonly documentTypeId: string }
  /** The job answered `desconhecido`, or an answer this tenant's current type
   * list no longer contains — tier 3 (the dropdown) is what resolves it now. */
  | { readonly outcome: "unresolved" }
  /** A human already picked a type (`setDocumentType`) while the job was in
   * flight — the manual choice is never clobbered by a late model answer. */
  | { readonly outcome: "skipped-manual" }
  /** This job is not the document's CURRENT detect job — a newer job (or a
   * newer tier-1/manual answer) already superseded it (codex review,
   * 2026-08-20). Applying it would overwrite a newer result with an older
   * one, so it is dropped instead. */
  | { readonly outcome: "stale-job" };

/**
 * Resolves a finished `detect` job's result onto its document.
 *
 * Re-derives the label→id mapping from the CURRENT `loadClassifiableTypes`
 * rather than trusting anything cached at enqueue time — a document type
 * renamed or removed between enqueue and this call must not silently bind to
 * a stale id.
 *
 * NEITHER the currency guard NOR the manual guard is a separate read-then-act
 * check (codex review, 2026-08-20): the currency guard reads
 * `documents.detect_job_id` here because staleness is about WHICH JOB is
 * current, a fact only a job id can settle, and nothing races it (only
 * `runDetection` ever writes that column, always to the job it just
 * committed). The manual guard is different — `setDocumentType` can land at
 * any time — so it is NOT checked by reading `doc.detectedBy` here; it is
 * enforced by `applyDetectedType`'s own CAS at write time, and this function
 * simply reports whatever that write decided.
 */
export async function applyDetectionResult(
  dbHandle: DbLike,
  ctx: { readonly tenantId: string; readonly userId: string },
  reportJobId: string,
): Promise<ApplyDetectionOutcome> {
  const jobRows = await dbHandle
    .select()
    .from(reportJobs)
    .where(and(eq(reportJobs.id, reportJobId), eq(reportJobs.tenantId, ctx.tenantId)))
    .limit(1);
  const job = jobRows[0];
  if (job === undefined) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Trabalho não encontrado." });
  }
  if (job.kind !== "detect") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Trabalho não é de detecção de tipo." });
  }
  if (job.status !== "done") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Detecção ainda não concluída." });
  }
  if (job.documentId === null) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Trabalho sem documento associado." });
  }

  const doc = await loadOwnedDocument(dbHandle, ctx.tenantId, job.documentId);
  if (doc === undefined) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Documento não encontrado." });
  }

  // Currency guard: only the document's CURRENT detect job may resolve onto
  // it. `runDetection` is the sole writer of `detect_job_id`, always setting
  // it to the job it just committed (and `applyDetectedType` clears it on
  // ANY resolution — hint, model, or the manual write's own CAS never
  // touching it does not matter, since a manual write always wins anyway) —
  // so a mismatch here means an older job finished after a newer one already
  // superseded it.
  if (doc.detectJobId !== reportJobId) {
    return { outcome: "stale-job" };
  }

  const label = modelAnswerLabel(job.result);
  if (label === null || label === UNKNOWN_TYPE_LABEL) {
    return { outcome: "unresolved" };
  }

  const types = await loadClassifiableTypes(dbHandle, ctx.tenantId);
  const match = types.find((t) => t.label === label);
  if (match === undefined) {
    return { outcome: "unresolved" };
  }

  const applied = await applyDetectedType(dbHandle, ctx, doc.id, match.documentTypeId, "model");
  if (!applied) {
    return { outcome: "skipped-manual" };
  }
  return { outcome: "applied", documentTypeId: match.documentTypeId };
}

/** The `detect` job's `result` column holds the relay envelope verbatim
 * (`{content, usage, model, provider}`, per api/collector/collect.ts's
 * `applySuccess` — a `detect` job is never parsed by the collector). `content`
 * is the model's raw JSON text; only from there is it the `{document_type}`
 * shape `classify-job.ts`'s schema asked for. Returns `null` for anything
 * that is not that shape — a job that failed, or an envelope the collector
 * could not read — which `applyDetectionResult` treats as "unresolved", not
 * as a fault. */
function modelAnswerLabel(result: unknown): string | null {
  if (typeof result !== "object" || result === null) {
    return null;
  }
  const content = (result as Record<string, unknown>)["content"];
  if (typeof content !== "string") {
    return null;
  }
  const parsed = parseModelJson(content);
  if (!parsed.ok) {
    return null;
  }
  const label = parsed.data["document_type"];
  return typeof label === "string" ? label : null;
}

/**
 * Tier 3: the always-present, always-correctable dropdown (§3.3). Re-proves
 * `documentTypeId` belongs to the tenant (the same guard `confirmUpload`
 * applies to a client-supplied FK) and re-proves document ownership via the
 * scoped WHERE, then stamps `detected_by = 'manual'` — the one value that
 * `applyDetectionResult` above will never overwrite.
 */
export async function setDocumentTypeManually(
  dbHandle: DbLike,
  ctx: { readonly tenantId: string; readonly userId: string },
  documentId: string,
  documentTypeId: string,
): Promise<void> {
  await assertReferencesOwnedByTenant(dbHandle, ctx.tenantId, { documentTypeId });

  const rows = await dbHandle
    .update(documents)
    .set(
      withSystemFields({ userId: ctx.userId }, "update", {
        documentTypeId,
        detectedBy: "manual",
      }),
    )
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.tenantId, ctx.tenantId),
        isNull(documents.deletedAt),
      ),
    )
    .returning({ id: documents.id });

  if (rows.length === 0) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Documento não encontrado." });
  }
}
