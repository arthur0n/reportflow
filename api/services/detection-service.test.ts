// api/services/detection-service.test.ts
//
// Drives the orchestration decisions, not the SQL or the lower tiers: tier 1
// (api/detection/detect.ts), tier 2's job builder (api/detection/classify-job.ts)
// and page-1 extraction (api/detection/page-text.ts) are each proven in their
// own suites and are mocked here, the same reasoning as
// api/collector/collect.test.ts — this file's property is "which outcome does
// a given tier-1/tier-2 answer produce, and what does it write", not whether
// unpdf or a join clause is correct.
//
// CAS races (codex review, 2026-08-20): `applyDetectedType`'s guard is a
// WRITE-TIME `detected_by IS DISTINCT FROM 'manual'`, not a read-then-check —
// so these tests simulate a race by giving the mocked `.returning()` an EMPTY
// result (the CAS matched zero rows), never by asserting on a read that
// happened first. Duplicate-job dedupe and the `detect_job_id` currency guard
// are exercised the same way: through the outcome the function returns, not
// through inspecting an intermediate read.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import type { DbLike } from "../collector/job-state";

const pageText = vi.hoisted(() => ({ extractPageOneText: vi.fn() }));
vi.mock("../detection/page-text", () => pageText);

const detect = vi.hoisted(() => ({ detectDocumentType: vi.fn() }));
vi.mock("../detection/detect", () => detect);

const classifyJob = vi.hoisted(() => ({
  buildDetectJob: vi.fn(),
  loadClassifiableTypes: vi.fn(),
  UNKNOWN_TYPE_LABEL: "desconhecido",
}));
vi.mock("../detection/classify-job", () => classifyJob);

const relay = vi.hoisted(() => ({
  jobKeyFor: vi.fn((tenantId: string, jobId: string) => `jobs/${tenantId}/${jobId}.json`),
  mintJobId: vi.fn(() => "11111111-1111-4111-8111-111111111111-a1"),
}));
vi.mock("../lib/relay", () => relay);

const crud = vi.hoisted(() => ({ assertReferencesOwnedByTenant: vi.fn() }));
vi.mock("./documents-crud", () => crud);

const { runDetection, applyDetectionResult, setDocumentTypeManually } =
  await import("./detection-service");

const TENANT = "org_2abcTENANT";
const USER = "user-1";
const DOC_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ROW_ID = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  pageText.extractPageOneText.mockReset();
  detect.detectDocumentType.mockReset();
  classifyJob.buildDetectJob.mockReset();
  classifyJob.loadClassifiableTypes.mockReset();
  relay.jobKeyFor.mockClear();
  relay.mintJobId.mockClear();
  crud.assertReferencesOwnedByTenant.mockReset().mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Fake db — one flexible handle covering every shape this file's queries use.
// `selectQueue` is consumed IN ORDER, one array of rows per `select()` call.
// `updateReturning` drives EVERY `.returning()` call on the update chain —
// tests that need CAS to succeed must set it to a non-empty array; the
// default (`[]`) is a CAS that matches nothing, which is deliberate: it is
// what most directly proves a caller checks the write's outcome rather than
// assuming success.
// ---------------------------------------------------------------------------

function makeDb(opts: {
  selectQueue?: unknown[][];
  insertReturning?: unknown[];
  updateReturning?: unknown[];
}) {
  const queue = [...(opts.selectQueue ?? [])];
  const select = vi.fn().mockImplementation(() => {
    const rows = queue.shift() ?? [];
    const limit = vi.fn().mockResolvedValue(rows);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    return { from };
  });

  const insertReturning = vi.fn().mockResolvedValue(opts.insertReturning ?? []);
  const insertValues = vi.fn().mockReturnValue({ returning: insertReturning });
  const insert = vi.fn().mockReturnValue({ values: insertValues });

  // Covers BOTH update shapes this file uses: `.where(...)` awaited directly
  // (stampDetectJobId, no returning) and `.where(...).returning(...)`
  // (applyDetectedType's CAS, setDocumentTypeManually). Both are supported on
  // the same mock — the returned object is thenable AND carries `.returning()`.
  const updateReturning = vi.fn().mockResolvedValue(opts.updateReturning ?? []);
  const updateWhere = vi.fn().mockImplementation(() => ({
    returning: updateReturning,
    then: (resolve: (v: unknown) => void) => {
      resolve(undefined);
    },
  }));
  const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set: updateSet });

  return {
    db: { select, insert, update } as unknown as DbLike,
    select,
    insert,
    insertValues,
    update,
    updateSet,
    updateWhere,
    updateReturning,
  };
}

const enqueue = vi.fn().mockResolvedValue(undefined);

describe("runDetection — tier 1", () => {
  beforeEach(() => {
    enqueue.mockClear();
  });

  it("refuses a document that does not belong to the caller's tenant", async () => {
    const { db } = makeDb({ selectQueue: [[]] });
    await expect(
      runDetection({ db, enqueue, fetchPdf: vi.fn() }, { tenantId: TENANT, userId: USER }, DOC_ID),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("tier 1 hit: updates the document, no job, does not touch tier 2", async () => {
    const { db, update, updateSet } = makeDb({
      selectQueue: [[{ id: DOC_ID, s3Key: `${TENANT}/doc.pdf`, tenantId: TENANT }]],
      updateReturning: [{ id: DOC_ID }],
    });
    const fetchPdf = vi.fn().mockResolvedValue(Buffer.from("pdf bytes"));
    pageText.extractPageOneText.mockResolvedValue("TOYSMITH COMÉRCIO\nNOTA FISCAL");
    detect.detectDocumentType.mockResolvedValue({
      tier: 1,
      documentTypeId: "dt-1",
      confidence: "hint",
    });

    const outcome = await runDetection(
      { db, enqueue, fetchPdf },
      { tenantId: TENANT, userId: USER },
      DOC_ID,
    );

    expect(outcome).toEqual({ outcome: "hint", documentTypeId: "dt-1" });
    expect(update).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ documentTypeId: "dt-1", detectedBy: "hint", detectJobId: null }),
    );
    expect(classifyJob.loadClassifiableTypes).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("tier 1 CAS race: a manual selection already won, so the hint is dropped", async () => {
    const { db } = makeDb({
      selectQueue: [[{ id: DOC_ID, s3Key: `${TENANT}/doc.pdf`, tenantId: TENANT }]],
      // Empty `.returning()` — the real WHERE clause's
      // `detected_by IS DISTINCT FROM 'manual'` matched zero rows because a
      // human's setDocumentType landed first.
      updateReturning: [],
    });
    pageText.extractPageOneText.mockResolvedValue("TOYSMITH COMÉRCIO\nNOTA FISCAL");
    detect.detectDocumentType.mockResolvedValue({
      tier: 1,
      documentTypeId: "dt-1",
      confidence: "hint",
    });

    const outcome = await runDetection(
      { db, enqueue, fetchPdf: vi.fn().mockResolvedValue(Buffer.from("x")) },
      { tenantId: TENANT, userId: USER },
      DOC_ID,
    );

    expect(outcome).toEqual({ outcome: "skipped-manual" });
    expect(classifyJob.loadClassifiableTypes).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("tier 1 miss + no configured document types: outcome 'none', nothing enqueued", async () => {
    const { db } = makeDb({
      selectQueue: [
        [{ id: DOC_ID, s3Key: `${TENANT}/doc.pdf`, tenantId: TENANT }],
        [], // loadPendingDetectJob — none pending
      ],
    });
    pageText.extractPageOneText.mockResolvedValue("algo qualquer");
    detect.detectDocumentType.mockResolvedValue(null);
    classifyJob.loadClassifiableTypes.mockResolvedValue([]);

    const outcome = await runDetection(
      { db, enqueue, fetchPdf: vi.fn().mockResolvedValue(Buffer.from("x")) },
      { tenantId: TENANT, userId: USER },
      DOC_ID,
    );

    expect(outcome).toEqual({ outcome: "none" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("no text layer (fetchPdf/extract → null) still tries tier 1 with null pageText, then falls through", async () => {
    const { db } = makeDb({
      selectQueue: [
        [{ id: DOC_ID, s3Key: `${TENANT}/doc.pdf`, tenantId: TENANT }],
        [], // loadPendingDetectJob — none pending
      ],
    });
    const fetchPdf = vi.fn().mockResolvedValue(Buffer.from("scanned, no text layer"));
    pageText.extractPageOneText.mockResolvedValue(null);
    detect.detectDocumentType.mockResolvedValue(null);
    classifyJob.loadClassifiableTypes.mockResolvedValue([]);

    await runDetection({ db, enqueue, fetchPdf }, { tenantId: TENANT, userId: USER }, DOC_ID);

    expect(detect.detectDocumentType).toHaveBeenCalledWith(db, TENANT, null);
  });
});

describe("runDetection — tier 2 fallthrough", () => {
  beforeEach(() => {
    enqueue.mockClear();
  });

  it("dedupes: reuses an already-pending detect job instead of enqueueing a new one", async () => {
    const EXISTING_JOB_ID = "66666666-6666-4666-8666-666666666666";
    const { db, insert } = makeDb({
      selectQueue: [
        [{ id: DOC_ID, s3Key: `${TENANT}/doc.pdf`, tenantId: TENANT }],
        [{ id: EXISTING_JOB_ID }], // loadPendingDetectJob — one already in flight
      ],
    });
    pageText.extractPageOneText.mockResolvedValue("texto qualquer");
    detect.detectDocumentType.mockResolvedValue(null);

    const outcome = await runDetection(
      { db, enqueue, fetchPdf: vi.fn().mockResolvedValue(Buffer.from("x")) },
      { tenantId: TENANT, userId: USER },
      DOC_ID,
    );

    expect(outcome).toEqual({ outcome: "job", jobId: EXISTING_JOB_ID });
    expect(classifyJob.loadClassifiableTypes).not.toHaveBeenCalled();
    expect(classifyJob.buildDetectJob).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("tier 1 miss + types configured: commits the job row, stamps detect_job_id, THEN enqueues", async () => {
    const jobRow = { id: JOB_ROW_ID };
    const { db, insert, insertValues, update, updateSet, updateWhere } = makeDb({
      selectQueue: [
        [{ id: DOC_ID, s3Key: `${TENANT}/doc.pdf`, tenantId: TENANT }],
        [], // loadPendingDetectJob — none pending
      ],
      insertReturning: [jobRow],
    });
    pageText.extractPageOneText.mockResolvedValue("texto qualquer");
    detect.detectDocumentType.mockResolvedValue(null);
    const types = [{ documentTypeId: "dt-1", label: "Toysmith / Nota Fiscal", hints: [] }];
    classifyJob.loadClassifiableTypes.mockResolvedValue(types);
    const payload = { channel: "ai", kind: "detect" };
    classifyJob.buildDetectJob.mockReturnValue({
      payload,
      labelToDocumentTypeId: new Map(),
    });

    const callOrder: string[] = [];
    insert.mockImplementation(() => {
      callOrder.push("insert");
      return { values: insertValues };
    });
    update.mockImplementation(() => {
      callOrder.push("update");
      return { set: updateSet };
    });
    const trackedEnqueue = vi.fn().mockImplementation(async () => {
      callOrder.push("enqueue");
    });

    const outcome = await runDetection(
      { db, enqueue: trackedEnqueue, fetchPdf: vi.fn().mockResolvedValue(Buffer.from("x")) },
      { tenantId: TENANT, userId: USER },
      DOC_ID,
    );

    expect(outcome).toEqual({ outcome: "job", jobId: JOB_ROW_ID });
    expect(classifyJob.buildDetectJob).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, s3Key: `${TENANT}/doc.pdf`, types }),
    );
    // Stamps documents.detect_job_id with the NEW job's row id, before enqueueing.
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ detectJobId: JOB_ROW_ID }));
    expect(updateWhere).toHaveBeenCalled();
    expect(trackedEnqueue).toHaveBeenCalledWith(TENANT, expect.any(String), payload);
    expect(callOrder).toEqual(["insert", "update", "enqueue"]);
  });
});

describe("applyDetectionResult — guards", () => {
  const REPORT_JOB_ID = "44444444-4444-4444-8444-444444444444";

  it("throws NOT_FOUND for a job the tenant does not own", async () => {
    const { db } = makeDb({ selectQueue: [[]] });
    await expect(
      applyDetectionResult(db, { tenantId: TENANT, userId: USER }, REPORT_JOB_ID),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a job that is not kind 'detect'", async () => {
    const { db } = makeDb({
      selectQueue: [[{ id: REPORT_JOB_ID, kind: "extract", status: "done", documentId: DOC_ID }]],
    });
    await expect(
      applyDetectionResult(db, { tenantId: TENANT, userId: USER }, REPORT_JOB_ID),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a job that has not settled yet", async () => {
    const { db } = makeDb({
      selectQueue: [[{ id: REPORT_JOB_ID, kind: "detect", status: "pending", documentId: DOC_ID }]],
    });
    await expect(
      applyDetectionResult(db, { tenantId: TENANT, userId: USER }, REPORT_JOB_ID),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("returns 'stale-job' when the document's current detect job is a different (newer) one", async () => {
    const { db } = makeDb({
      selectQueue: [
        [{ id: REPORT_JOB_ID, kind: "detect", status: "done", documentId: DOC_ID, result: {} }],
        [{ id: DOC_ID, tenantId: TENANT, detectedBy: null, detectJobId: "some-newer-job-id" }],
      ],
    });
    const outcome = await applyDetectionResult(
      db,
      { tenantId: TENANT, userId: USER },
      REPORT_JOB_ID,
    );
    expect(outcome).toEqual({ outcome: "stale-job" });
    expect(classifyJob.loadClassifiableTypes).not.toHaveBeenCalled();
  });
});

describe("applyDetectionResult — resolving the answer", () => {
  const REPORT_JOB_ID = "44444444-4444-4444-8444-444444444444";

  it("write-time CAS reports 'skipped-manual' when a manual selection already won the race", async () => {
    const { db, update } = makeDb({
      selectQueue: [
        [
          {
            id: REPORT_JOB_ID,
            kind: "detect",
            status: "done",
            documentId: DOC_ID,
            result: { content: JSON.stringify({ document_type: "Toysmith / Nota Fiscal" }) },
          },
        ],
        [{ id: DOC_ID, tenantId: TENANT, detectedBy: "manual", detectJobId: REPORT_JOB_ID }],
      ],
      // The write's WHERE clause (`detected_by IS DISTINCT FROM 'manual'`)
      // matches nothing — this is what actually produces the outcome below,
      // not a read of `detectedBy` beforehand.
      updateReturning: [],
    });
    classifyJob.loadClassifiableTypes.mockResolvedValue([
      { documentTypeId: "dt-1", label: "Toysmith / Nota Fiscal", hints: [] },
    ]);

    const outcome = await applyDetectionResult(
      db,
      { tenantId: TENANT, userId: USER },
      REPORT_JOB_ID,
    );

    expect(outcome).toEqual({ outcome: "skipped-manual" });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("resolves 'unresolved' when the model answered the unknown sentinel", async () => {
    const { db } = makeDb({
      selectQueue: [
        [
          {
            id: REPORT_JOB_ID,
            kind: "detect",
            status: "done",
            documentId: DOC_ID,
            result: { content: JSON.stringify({ document_type: "desconhecido" }) },
          },
        ],
        [{ id: DOC_ID, tenantId: TENANT, detectedBy: null, detectJobId: REPORT_JOB_ID }],
      ],
    });
    const outcome = await applyDetectionResult(
      db,
      { tenantId: TENANT, userId: USER },
      REPORT_JOB_ID,
    );
    expect(outcome).toEqual({ outcome: "unresolved" });
  });
});

describe("applyDetectionResult — resolving the answer (continued)", () => {
  const REPORT_JOB_ID = "44444444-4444-4444-8444-444444444444";

  it("resolves 'unresolved' when the model's label matches no CURRENT type", async () => {
    const { db } = makeDb({
      selectQueue: [
        [
          {
            id: REPORT_JOB_ID,
            kind: "detect",
            status: "done",
            documentId: DOC_ID,
            result: { content: JSON.stringify({ document_type: "Toysmith / Nota Fiscal" }) },
          },
        ],
        [{ id: DOC_ID, tenantId: TENANT, detectedBy: null, detectJobId: REPORT_JOB_ID }],
      ],
    });
    classifyJob.loadClassifiableTypes.mockResolvedValue([]);
    const outcome = await applyDetectionResult(
      db,
      { tenantId: TENANT, userId: USER },
      REPORT_JOB_ID,
    );
    expect(outcome).toEqual({ outcome: "unresolved" });
  });

  it("applies the matched type and stamps detected_by='model'", async () => {
    const { db, update, updateSet } = makeDb({
      selectQueue: [
        [
          {
            id: REPORT_JOB_ID,
            kind: "detect",
            status: "done",
            documentId: DOC_ID,
            result: { content: JSON.stringify({ document_type: "Toysmith / Nota Fiscal" }) },
          },
        ],
        [{ id: DOC_ID, tenantId: TENANT, detectedBy: null, detectJobId: REPORT_JOB_ID }],
      ],
      updateReturning: [{ id: DOC_ID }],
    });
    classifyJob.loadClassifiableTypes.mockResolvedValue([
      { documentTypeId: "dt-1", label: "Toysmith / Nota Fiscal", hints: [] },
    ]);

    const outcome = await applyDetectionResult(
      db,
      { tenantId: TENANT, userId: USER },
      REPORT_JOB_ID,
    );

    expect(outcome).toEqual({ outcome: "applied", documentTypeId: "dt-1" });
    expect(update).toHaveBeenCalledTimes(1);
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ documentTypeId: "dt-1", detectedBy: "model", detectJobId: null }),
    );
  });
});

describe("setDocumentTypeManually", () => {
  it("re-proves documentTypeId ownership before writing", async () => {
    const { db } = makeDb({ updateReturning: [{ id: DOC_ID }] });
    crud.assertReferencesOwnedByTenant.mockRejectedValue(
      new TRPCError({ code: "BAD_REQUEST", message: "Tipo de documento inválido." }),
    );
    await expect(
      setDocumentTypeManually(db, { tenantId: TENANT, userId: USER }, DOC_ID, "dt-1"),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("stamps detected_by='manual' on a successful write", async () => {
    const { db, updateSet } = makeDb({ updateReturning: [{ id: DOC_ID }] });
    await setDocumentTypeManually(db, { tenantId: TENANT, userId: USER }, DOC_ID, "dt-1");
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ documentTypeId: "dt-1", detectedBy: "manual" }),
    );
  });

  it("throws NOT_FOUND when no row matched the tenant-scoped update", async () => {
    const { db } = makeDb({ updateReturning: [] });
    await expect(
      setDocumentTypeManually(db, { tenantId: TENANT, userId: USER }, DOC_ID, "dt-1"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
