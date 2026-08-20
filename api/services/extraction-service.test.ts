// api/services/extraction-service.test.ts
//
// Drives hop 1's orchestration, not its parts: the field-list → prompt/schema
// rendering is proven in shared/validation/field-spec.test.ts, the validator in
// shared/validation/extraction-validation.test.ts, and the job state machine in
// job-state.test.ts. What is under test HERE is what this file decides — when a
// paid hop is bought, what payload it buys, and what a human's correction is
// allowed to write.
//
// `api/extraction/extract-job.ts` is deliberately NOT mocked. It is pure, and
// the `text` vs `vision` fork (§3.1's cost decision) is exactly the property
// two of the cases below assert — a stubbed builder would be the thing
// deciding it.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbLike } from "../collector/job-state";

const store = vi.hoisted(() => ({ loadTemplateFields: vi.fn() }));
vi.mock("../collector/extraction-store", () => store);

const jobState = vi.hoisted(() => ({
  loadLatestJobForDocument: vi.fn(),
  resolveRevisarJob: vi.fn(),
}));
vi.mock("../collector/job-state", () => jobState);

const pageText = vi.hoisted(() => ({ extractDocumentText: vi.fn() }));
vi.mock("../detection/page-text", () => pageText);

const relay = vi.hoisted(() => ({
  jobKeyFor: vi.fn((tenantId: string, jobId: string) => `jobs/${tenantId}/${jobId}.json`),
  mintJobId: vi.fn(() => "11111111-1111-4111-8111-111111111111-a1"),
}));
vi.mock("../lib/relay", () => relay);

const { startExtraction, correctExtraction, getExtractionView } =
  await import("./extraction-service");

const TENANT = "org_2abcTENANT";
const USER = "user-1";
const DOC_ID = "22222222-2222-4222-8222-222222222222";
const TYPE_ID = "33333333-3333-4333-8333-333333333333";
const TEMPLATE_ID = "44444444-4444-4444-8444-444444444444";
const JOB_ROW_ID = "55555555-5555-4555-8555-555555555555";
const EXTRACTION_ID = "66666666-6666-4666-8666-666666666666";
const S3_KEY = `${TENANT}/doc.pdf`;
const CTX = { tenantId: TENANT, userId: USER };

const FIELDS = [
  { name: "numero", type: "string", required: true, description: "nº" },
  { name: "iliquido", type: "money", required: true, description: "total" },
] as const;

const VALID_DATA = { numero: "FT 1", iliquido: "1.234,56 €" };

const DOC = {
  id: DOC_ID,
  tenantId: TENANT,
  s3Key: S3_KEY,
  fileName: "doc.pdf",
  documentTypeId: TYPE_ID,
};

function template(over: Record<string, unknown> = {}) {
  return {
    id: TEMPLATE_ID,
    inputMode: "text",
    calibrationRev: 1,
    providerName: "Toysmith",
    typeName: "Nota Fiscal",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Fake db. `selectQueue` is consumed IN ORDER, one array of rows per
// `select()`; every chain shape this file uses (`.where().limit()`,
// `.innerJoin().where().limit()`, `.where().orderBy()`) resolves to the same
// queued rows, because the property under test is never the SQL — it is which
// read happened and what the code did with the answer.
// ---------------------------------------------------------------------------

function makeDb(opts: {
  selectQueue?: unknown[][];
  insertReturning?: unknown[];
  upsertReturning?: unknown[];
}) {
  const queue = [...(opts.selectQueue ?? [])];

  const select = vi.fn().mockImplementation(() => {
    const rows = queue.shift() ?? [];
    const chain: Record<string, unknown> = {};
    const self = (): Record<string, unknown> => chain;
    Object.assign(chain, {
      from: self,
      innerJoin: self,
      leftJoin: self,
      where: self,
      orderBy: self,
      limit: () => Promise.resolve(rows),
      then: (resolve: (v: unknown) => void) => {
        resolve(rows);
      },
    });
    return chain;
  });

  const insertReturning = vi.fn().mockResolvedValue(opts.insertReturning ?? []);
  const upsertReturning = vi.fn().mockResolvedValue(opts.upsertReturning ?? []);
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning: upsertReturning });
  // `startExtraction` inserts with ON CONFLICT DO NOTHING (the partial unique
  // index on a pending extract job); `correctExtraction` upserts on the cache
  // key. One handle serves both shapes.
  const onConflictDoNothing = vi.fn().mockReturnValue({ returning: insertReturning });
  const insertValues = vi.fn().mockReturnValue({
    returning: insertReturning,
    onConflictDoNothing,
    onConflictDoUpdate,
  });
  const insert = vi.fn().mockReturnValue({ values: insertValues });

  return {
    db: { select, insert } as unknown as DbLike,
    select,
    insert,
    insertValues,
    onConflictDoNothing,
    onConflictDoUpdate,
  };
}

const enqueue = vi.fn().mockResolvedValue(undefined);
const fetchPdf = vi.fn();

beforeEach(() => {
  store.loadTemplateFields.mockReset().mockResolvedValue(FIELDS);
  jobState.loadLatestJobForDocument.mockReset().mockResolvedValue(undefined);
  jobState.resolveRevisarJob.mockReset().mockResolvedValue(1);
  pageText.extractDocumentText.mockReset().mockResolvedValue("[página 1]\ntexto");
  relay.mintJobId.mockClear();
  enqueue.mockClear();
  fetchPdf.mockReset().mockResolvedValue(Buffer.from("%PDF-"));
});

/** Reads the payload the enqueue was called with. */
function enqueuedPayload(): Record<string, unknown> {
  return enqueue.mock.calls[0]?.[2] as Record<string, unknown>;
}

describe("startExtraction — refusals", () => {
  it("refuses a document that does not belong to the caller's tenant", async () => {
    const { db } = makeDb({ selectQueue: [[]] });
    await expect(startExtraction({ db, enqueue, fetchPdf }, CTX, DOC_ID)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  // §3.3 runs first, and it has to: extraction is validated against the field
  // list of a TYPE, so a document with no type has nothing to be right about.
  it("refuses a document with no document type", async () => {
    const { db } = makeDb({ selectQueue: [[{ ...DOC, documentTypeId: null }]] });
    await expect(startExtraction({ db, enqueue, fetchPdf }, CTX, DOC_ID)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses a type with no frozen extract template", async () => {
    const { db } = makeDb({ selectQueue: [[DOC], []] });
    await expect(startExtraction({ db, enqueue, fetchPdf }, CTX, DOC_ID)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  // §3.1 has NO fallback ladder: `text` is a cost decision a human made during
  // Calibrate, and quietly promoting it to a 5–20× vision hop would spend
  // their money to hide their mistake.
  it("refuses text mode against a PDF with no text layer instead of going vision", async () => {
    const { db } = makeDb({ selectQueue: [[DOC], [template()], [], []] });
    pageText.extractDocumentText.mockResolvedValue(null);
    await expect(startExtraction({ db, enqueue, fetchPdf }, CTX, DOC_ID)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("startExtraction — idempotency (§12.8)", () => {
  // The cache key is (s3_key, calibration_rev). A hit is FREE and is the whole
  // of "extraction cached".
  it("skips when an extraction already exists at the current calibration rev", async () => {
    const { db, insert } = makeDb({
      selectQueue: [[DOC], [template()], [{ id: EXTRACTION_ID, corrected: false }]],
    });
    await expect(startExtraction({ db, enqueue, fetchPdf }, CTX, DOC_ID)).resolves.toEqual({
      outcome: "cached",
      extractionId: EXTRACTION_ID,
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  // §4.2 — "the corrected extraction is persisted and never re-run". It needs
  // no flag check: a correction lives at the same cache key.
  it("skips a CORRECTED extraction by the same cache key", async () => {
    const { db } = makeDb({
      selectQueue: [[DOC], [template()], [{ id: EXTRACTION_ID, corrected: true }]],
    });
    await expect(startExtraction({ db, enqueue, fetchPdf }, CTX, DOC_ID)).resolves.toEqual({
      outcome: "cached",
      extractionId: EXTRACTION_ID,
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  // A double-clicked [Extrair] must not buy a second read of the same PDF.
  it("reuses an extract job already in flight for the document", async () => {
    const { db, insert } = makeDb({
      selectQueue: [[DOC], [template()], [], [{ id: JOB_ROW_ID }]],
    });
    await expect(startExtraction({ db, enqueue, fetchPdf }, CTX, DOC_ID)).resolves.toEqual({
      outcome: "job",
      jobId: JOB_ROW_ID,
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("startExtraction — the job it builds", () => {
  function readyDb(mode: "text" | "vision") {
    return makeDb({
      selectQueue: [[DOC], [template({ inputMode: mode })], [], []],
      insertReturning: [{ id: JOB_ROW_ID }],
    });
  }

  // §3.1 — "text mode" means the model gets the extracted text layer INSTEAD
  // of the PDF. A `document` on this payload would be the whole cost decision
  // undone.
  it("text mode embeds the locally-extracted text and sends NO document", async () => {
    const { db } = readyDb("text");
    await expect(startExtraction({ db, enqueue, fetchPdf }, CTX, DOC_ID)).resolves.toEqual({
      outcome: "job",
      jobId: JOB_ROW_ID,
    });
    const payload = enqueuedPayload();
    expect(payload["kind"]).toBe("extract");
    expect(payload["document"]).toBeUndefined();
    expect(String(payload["prompt"])).toContain("[página 1]");
    expect(String(payload["prompt"])).toContain("iliquido");
    expect(fetchPdf).toHaveBeenCalledWith(S3_KEY);
  });

  it("vision mode sends the document by s3Key and never reads the PDF locally", async () => {
    const { db } = readyDb("vision");
    await startExtraction({ db, enqueue, fetchPdf }, CTX, DOC_ID);
    expect(enqueuedPayload()["document"]).toEqual({ s3Key: S3_KEY });
    expect(fetchPdf).not.toHaveBeenCalled();
  });

  it("derives the provider schema from the same frozen list as the prompt", async () => {
    const { db } = readyDb("vision");
    await startExtraction({ db, enqueue, fetchPdf }, CTX, DOC_ID);
    const schema = enqueuedPayload()["schema"] as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(["numero", "iliquido"]);
  });

  // api/collector/collect.ts's requirement on EVERY enqueue path: a fast relay
  // must not be able to produce a result for a row nobody can see yet.
  it("commits the report_jobs row BEFORE the PutObject", async () => {
    const order: string[] = [];
    const { db, insertValues } = readyDb("vision");
    insertValues.mockImplementation(() => ({
      onConflictDoNothing: () => ({
        returning: () => {
          order.push("row");
          return Promise.resolve([{ id: JOB_ROW_ID }]);
        },
      }),
    }));
    enqueue.mockImplementation(async () => {
      order.push("outbox");
    });
    await startExtraction({ db, enqueue, fetchPdf }, CTX, DOC_ID);
    expect(order).toEqual(["row", "outbox"]);
  });
});

// ---------------------------------------------------------------------------
// The double-bill race (codex review, 2026-08-20). Two concurrent callers —
// a double-clicked [Extrair], two tabs, a retried request — used to pass the
// same read-based preflight and both buy a hop. The §12.8 cache cannot cover
// it: at the moment of the race NEITHER extraction exists yet.
// ---------------------------------------------------------------------------

describe("startExtraction — concurrent callers buy exactly one hop", () => {
  const WINNER_JOB_ID = "77777777-7777-4777-8777-777777777777";

  function racingDb(opts: { inserted: unknown[]; winner?: unknown[] }) {
    return makeDb({
      // doc, template, cached (none), pending preflight (none), then — only
      // on the loser's path — the re-read that finds the winner.
      selectQueue: [[DOC], [template({ inputMode: "vision" })], [], [], opts.winner ?? []],
      insertReturning: opts.inserted,
    });
  }

  // The guarantee is the INSERT, not the read before it: ON CONFLICT DO
  // NOTHING against `report_jobs_pending_extract_idx`.
  it("the winner inserts, enqueues, and returns its own row", async () => {
    const { db, onConflictDoNothing } = racingDb({ inserted: [{ id: JOB_ROW_ID }] });

    await expect(startExtraction({ db, enqueue, fetchPdf }, CTX, DOC_ID)).resolves.toEqual({
      outcome: "job",
      jobId: JOB_ROW_ID,
    });

    expect(onConflictDoNothing).toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledOnce();
  });

  // The loser inserted nothing and MUST NOT write a second job object — that
  // object is what the relay bills against.
  it("the loser writes no job object and reports the winner's row", async () => {
    const { db } = racingDb({ inserted: [], winner: [{ id: WINNER_JOB_ID }] });

    await expect(startExtraction({ db, enqueue, fetchPdf }, CTX, DOC_ID)).resolves.toEqual({
      outcome: "job",
      jobId: WINNER_JOB_ID,
    });

    expect(enqueue).not.toHaveBeenCalled();
  });

  // The caller cannot tell which of the two it was — same shape, same field,
  // pollable the same way.
  it("gives the loser an outcome indistinguishable from the winner's", async () => {
    const winnerDb = racingDb({ inserted: [{ id: WINNER_JOB_ID }] });
    const winner = await startExtraction({ db: winnerDb.db, enqueue, fetchPdf }, CTX, DOC_ID);

    enqueue.mockClear();
    const loserDb = racingDb({ inserted: [], winner: [{ id: WINNER_JOB_ID }] });
    const loser = await startExtraction({ db: loserDb.db, enqueue, fetchPdf }, CTX, DOC_ID);

    expect(loser).toEqual(winner);
  });

  // A window a few milliseconds wide: the conflicting row settled between the
  // INSERT and the re-read. Nothing was written and there is nothing pending
  // to point at, so it says so rather than inventing an outcome.
  it("refuses rather than inventing a job when the conflict has already settled", async () => {
    const { db } = racingDb({ inserted: [], winner: [] });

    await expect(startExtraction({ db, enqueue, fetchPdf }, CTX, DOC_ID)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("correctExtraction", () => {
  it("refuses a document that does not belong to the caller's tenant", async () => {
    const { db } = makeDb({ selectQueue: [[]] });
    await expect(
      correctExtraction(db, CTX, { documentId: DOC_ID, data: VALID_DATA }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  // The gate §4.2 implies: everything downstream reads `extractions.data` as a
  // payload that already satisfies the frozen list, so a half-repaired one
  // cannot leave `revisar`.
  it("refuses a correction that is still invalid, and writes nothing", async () => {
    const { db, insert } = makeDb({ selectQueue: [[DOC], [template()]] });
    await expect(
      correctExtraction(db, CTX, { documentId: DOC_ID, data: { numero: "FT 1", iliquido: null } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(insert).not.toHaveBeenCalled();
    expect(jobState.resolveRevisarJob).not.toHaveBeenCalled();
  });

  it("persists a valid correction at the cache key, marked corrected", async () => {
    const { db, insertValues, onConflictDoUpdate } = makeDb({
      selectQueue: [[DOC], [template()]],
      upsertReturning: [{ id: EXTRACTION_ID }],
    });
    await expect(
      correctExtraction(db, CTX, { documentId: DOC_ID, data: VALID_DATA }),
    ).resolves.toEqual({ extractionId: EXTRACTION_ID, resolvedJobs: 1 });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        s3Key: S3_KEY,
        calibrationRev: 1,
        corrected: true,
        data: VALID_DATA,
      }),
    );
    // The conflict TARGET is the cache key, and the SET is what makes the
    // correction the row that wins — asserted by reading the call rather than
    // by a nested matcher, which types as `any`.
    const conflict = onConflictDoUpdate.mock.calls[0]?.[0] as {
      target: unknown[];
      set: Record<string, unknown>;
    };
    expect(conflict.target).toHaveLength(2);
    expect(conflict.set["corrected"]).toBe(true);
    expect(conflict.set["data"]).toEqual(VALID_DATA);
  });

  // CAS'd on `status = 'revisar'`, and AFTER the write: if the process dies
  // between them the row is still `revisar` and saving again is a no-op.
  it("closes the revisar job after the extraction is written", async () => {
    const order: string[] = [];
    const { db, insertValues } = makeDb({
      selectQueue: [[DOC], [template()]],
    });
    insertValues.mockImplementation(() => ({
      onConflictDoUpdate: () => ({
        returning: () => {
          order.push("extraction");
          return Promise.resolve([{ id: EXTRACTION_ID }]);
        },
      }),
    }));
    jobState.resolveRevisarJob.mockImplementation(async () => {
      order.push("job");
      return 1;
    });

    await correctExtraction(db, CTX, { documentId: DOC_ID, data: VALID_DATA });

    expect(order).toEqual(["extraction", "job"]);
    expect(jobState.resolveRevisarJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: TENANT, documentId: DOC_ID, kind: "extract" }),
    );
  });

  // Ordinary, not an error: a valid-but-disputed extraction has no `revisar`
  // job to close.
  it("reports zero resolved jobs without failing", async () => {
    const { db } = makeDb({
      selectQueue: [[DOC], [template()]],
      upsertReturning: [{ id: EXTRACTION_ID }],
    });
    jobState.resolveRevisarJob.mockResolvedValue(0);
    await expect(
      correctExtraction(db, CTX, { documentId: DOC_ID, data: VALID_DATA }),
    ).resolves.toEqual({ extractionId: EXTRACTION_ID, resolvedJobs: 0 });
  });
});

describe("getExtractionView", () => {
  it("refuses a document that does not belong to the caller's tenant", async () => {
    const { db } = makeDb({ selectQueue: [[]] });
    await expect(getExtractionView(db, CTX, DOC_ID)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  // Nothing invalid is ever in `extractions`, so a `revisar` screen's values
  // come from the relay envelope kept verbatim on the job row.
  it("reads a revisar payload out of the job result and flags its problems", async () => {
    jobState.loadLatestJobForDocument.mockResolvedValue({
      id: JOB_ROW_ID,
      status: "revisar",
      attempt: 2,
      error: "extração inválida",
      result: { content: JSON.stringify({ numero: "FT 1", iliquido: null }) },
    });
    const { db } = makeDb({ selectQueue: [[DOC], [template()], []] });

    const view = await getExtractionView(db, CTX, DOC_ID);

    expect(view.status).toBe("revisar");
    expect(view.extraction).toBeNull();
    expect(view.data).toEqual({ numero: "FT 1", iliquido: null });
    expect(view.problems.map((p) => p.path.join("."))).toEqual(["iliquido"]);
    expect(view.fields).toEqual(FIELDS);
  });

  it("shows a cached extraction as done with no problems", async () => {
    jobState.loadLatestJobForDocument.mockResolvedValue({
      id: JOB_ROW_ID,
      status: "done",
      attempt: 1,
      error: null,
      result: null,
    });
    const { db } = makeDb({
      selectQueue: [
        [DOC],
        [template()],
        [
          {
            id: EXTRACTION_ID,
            data: VALID_DATA,
            corrected: false,
            provider: "gemini",
            model: "gemini-3.5-flash",
            createdAt: "2026-08-20T00:00:00.000Z",
          },
        ],
      ],
    });

    const view = await getExtractionView(db, CTX, DOC_ID);

    expect(view.status).toBe("done");
    expect(view.problems).toEqual([]);
    expect(view.extraction?.id).toBe(EXTRACTION_ID);
  });

  it("reports a document with no frozen template without loading a field list", async () => {
    const { db } = makeDb({ selectQueue: [[DOC], []] });
    const view = await getExtractionView(db, CTX, DOC_ID);
    expect(view.template).toBeNull();
    expect(view.fields).toEqual([]);
    expect(store.loadTemplateFields).not.toHaveBeenCalled();
  });
});
