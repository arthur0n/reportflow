// api/services/calibration-service.test.ts
//
// The propose half of Calibrate. Two properties, and neither is about SQL:
//
//   1. OWNERSHIP AND ORDER — a sample document that is not the caller's is a
//      NOT_FOUND before anything is read or paid for, and the `report_jobs`
//      row is committed BEFORE the outbox PutObject (api/collector/collect.ts
//      requires it; a fast relay must never answer a row nobody can see).
//   2. NOTHING IS STORED BY THE PROPOSAL. `interpretProposalJob` is pure —
//      §3.1's human step is structural, not remembered.
//
// api/detection/page-text.ts is mocked (it is proven in its own suite and
// pulls unpdf in); api/calibration/propose-job.ts is NOT — it is pure, and
// keeping it real is what makes "the row's request is the payload the relay
// will get" a fact this test can assert rather than a mock's echo.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbLike, JobRow } from "../collector/job-state";

const pageText = vi.hoisted(() => ({ extractPageOneText: vi.fn() }));
vi.mock("../detection/page-text", () => pageText);

const relay = vi.hoisted(() => ({
  jobKeyFor: vi.fn((tenantId: string, jobId: string) => `jobs/${tenantId}/${jobId}.json`),
  mintJobId: vi.fn(() => "11111111-1111-4111-8111-111111111111-a1"),
}));
vi.mock("../lib/relay", () => relay);

const { proposeCalibration, interpretProposalJob } = await import("./calibration-service");

const TENANT = "org_2abcTENANT";
const USER = "user-1";
const DOC_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ROW_ID = "33333333-3333-4333-8333-333333333333";
const PROVIDER_ID = "44444444-4444-4444-8444-444444444444";

// ---------------------------------------------------------------------------
// Fake db. `selectQueue` is consumed IN ORDER, one array of rows per
// `select()`; `insertQueue` likewise per `insert()`. Both default to empty,
// which is the honest default: an empty result is what a wrong tenant sees.
// ---------------------------------------------------------------------------
function makeDb(opts: { selectQueue?: unknown[][]; insertQueue?: unknown[][] } = {}) {
  const selects = [...(opts.selectQueue ?? [])];
  const inserts = [...(opts.insertQueue ?? [])];
  const insertedValues: unknown[] = [];

  const select = vi.fn().mockImplementation(() => {
    const rows = selects.shift() ?? [];
    const limit = vi.fn().mockResolvedValue(rows);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    return { from };
  });

  const insert = vi.fn().mockImplementation(() => ({
    values: (value: unknown) => {
      insertedValues.push(value);
      const returning = vi.fn().mockImplementation(() => Promise.resolve(inserts.shift() ?? []));
      return { returning, onConflictDoNothing: () => ({ returning }) };
    },
  }));

  return { db: { select, insert } as unknown as DbLike, select, insert, insertedValues };
}

const enqueue = vi.fn().mockResolvedValue(undefined);
const fetchPdf = vi.fn();

beforeEach(() => {
  pageText.extractPageOneText.mockReset();
  relay.mintJobId.mockClear();
  enqueue.mockClear();
  fetchPdf.mockReset();
});

describe("proposeCalibration", () => {
  it("refuses a sample document that is not the caller's", async () => {
    const { db } = makeDb({ selectQueue: [[]] });
    await expect(
      proposeCalibration(
        { db, enqueue, fetchPdf },
        { tenantId: TENANT, userId: USER },
        { documentId: DOC_ID },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(fetchPdf).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  // A provider id is a lookup key, never a permission — the same rule
  // documents-crud.ts states for every client-supplied FK.
  it("refuses a provider id belonging to another tenant", async () => {
    const { db } = makeDb({
      selectQueue: [[{ id: DOC_ID, s3Key: `${TENANT}/sample.pdf` }], []],
    });
    await expect(
      proposeCalibration(
        { db, enqueue, fetchPdf },
        { tenantId: TENANT, userId: USER },
        { documentId: DOC_ID, providerId: PROVIDER_ID },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("enqueues an analyse/calibrate job and returns the row id to poll", async () => {
    const { db, insertedValues } = makeDb({
      selectQueue: [[{ id: DOC_ID, s3Key: `${TENANT}/sample.pdf` }]],
      insertQueue: [[{ id: JOB_ROW_ID }]],
    });
    fetchPdf.mockResolvedValue(Buffer.from("pdf"));
    pageText.extractPageOneText.mockResolvedValue("TOYSMITH COMÉRCIO");

    const out = await proposeCalibration(
      { db, enqueue, fetchPdf },
      { tenantId: TENANT, userId: USER },
      { documentId: DOC_ID },
    );

    expect(out).toEqual({ jobId: JOB_ROW_ID });
    const row = insertedValues[0] as Record<string, unknown>;
    expect(row["kind"]).toBe("analyse");
    expect(row["status"]).toBe("pending");
    expect(row["attempt"]).toBe(1);
    expect(row["documentId"]).toBe(DOC_ID);
    // The payload is kept verbatim so the collector can retry it (§4.2), and
    // it is what tells a later poll this job was a calibration proposal.
    const request = row["request"] as Record<string, unknown>;
    expect(request["purpose"]).toBe("calibrate");
    expect(String(request["prompt"])).toContain("TOYSMITH COMÉRCIO");
  });

  // api/collector/collect.ts's own requirement: a result that lands before the
  // row is visible is dropped as "no-job-row".
  it("commits the job row before it writes the outbox object", async () => {
    const order: string[] = [];
    const { db } = makeDb({
      selectQueue: [[{ id: DOC_ID, s3Key: `${TENANT}/sample.pdf` }]],
      insertQueue: [[{ id: JOB_ROW_ID }]],
    });
    const spiedInsert = (db as unknown as { insert: ReturnType<typeof vi.fn> }).insert;
    const realInsert = spiedInsert.getMockImplementation();
    spiedInsert.mockImplementation((...args: unknown[]) => {
      order.push("insert");
      return realInsert?.(...args) as unknown;
    });
    enqueue.mockImplementation(async () => {
      order.push("enqueue");
    });
    fetchPdf.mockResolvedValue(null);

    await proposeCalibration(
      { db, enqueue, fetchPdf },
      { tenantId: TENANT, userId: USER },
      { documentId: DOC_ID },
    );

    expect(order).toEqual(["insert", "enqueue"]);
  });

  // A scan with no text layer must not fail the proposal — it changes the
  // recommendation to `vision` and nothing else (§12.2's own fallthrough).
  it("proposes from a PDF with no text layer at all", async () => {
    const { db, insertedValues } = makeDb({
      selectQueue: [[{ id: DOC_ID, s3Key: `${TENANT}/sample.pdf` }]],
      insertQueue: [[{ id: JOB_ROW_ID }]],
    });
    fetchPdf.mockResolvedValue(null);

    await proposeCalibration(
      { db, enqueue, fetchPdf },
      { tenantId: TENANT, userId: USER },
      { documentId: DOC_ID },
    );

    const request = (insertedValues[0] as Record<string, unknown>)["request"] as Record<
      string,
      unknown
    >;
    expect(String(request["prompt"])).toContain("input_mode deve ser 'vision'");
    expect(pageText.extractPageOneText).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// interpretProposalJob
// ---------------------------------------------------------------------------

const PROPOSAL = {
  document_type_name: "Nota Fiscal",
  input_mode: "text",
  detect_hint: ["TOYSMITH COMÉRCIO", "NOTA FISCAL"],
  fields: [
    { name: "numero", type: "string", required: true, description: "Número do documento." },
    {
      name: "itens",
      type: "object[]",
      required: true,
      description: "Linhas.",
      fields: [{ name: "total", type: "money", required: true, description: "Total da linha." }],
    },
  ],
  sample_values_json: '{"numero":"1","itens":[{"total":"10,00 €"}]}',
};

function proposalRow(over: Partial<JobRow> = {}): JobRow {
  return {
    id: JOB_ROW_ID,
    tenantId: TENANT,
    kind: "analyse",
    status: "done",
    s3Key: `jobs/${TENANT}/job-a1.json`,
    attempt: 1,
    error: null,
    request: { channel: "ai", kind: "analyse", purpose: "calibrate" },
    result: { content: JSON.stringify(PROPOSAL), provider: "gemini", model: "m" },
    documentId: DOC_ID,
    reportId: null,
    createdAt: "2026-08-20T00:00:00.000Z",
    createdBy: USER,
    lastUpdAt: "2026-08-20T00:00:00.000Z",
    lastUpdBy: USER,
    ...over,
  };
}

describe("interpretProposalJob", () => {
  // `analyse` is a SHARED kind (see propose-job.ts). "This job id is mine" is
  // not the same question as "this job is a proposal", and answering the
  // second with the first would let a report analysis be read as a field list.
  it("refuses an analyse job that is not a calibration proposal", () => {
    expect(() => interpretProposalJob(proposalRow({ request: { channel: "ai" } }))).toThrow();
    expect(() => interpretProposalJob(proposalRow({ kind: "extract" }))).toThrow();
  });

  it("reports a pending job as pending", () => {
    expect(interpretProposalJob(proposalRow({ status: "pending" }))).toEqual({ status: "pending" });
  });

  it("surfaces the job's own error when the hop failed", () => {
    expect(
      interpretProposalJob(proposalRow({ status: "failed", error: "falha permanente" })),
    ).toEqual({ status: "failed", error: "falha permanente" });
  });

  it("normalises a ready proposal into the shape the editor and freeze share", () => {
    const outcome = interpretProposalJob(proposalRow());
    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") return;
    expect(outcome.proposal.documentTypeName).toBe("Nota Fiscal");
    expect(outcome.proposal.inputMode).toBe("text");
    expect(outcome.proposal.detectHint).toEqual(["TOYSMITH COMÉRCIO", "NOTA FISCAL"]);
    expect(outcome.proposal.fields[1]?.fields?.[0]?.name).toBe("total");
    expect(outcome.proposal.sampleValuesJson).toContain('"numero"');
  });

  // Distinct from `failed`: the money is spent either way, but only this one
  // is worth re-running.
  it("reports a well-formed job whose answer is not a proposal as unreadable", () => {
    expect(
      interpretProposalJob(proposalRow({ result: { content: "desculpe, não consegui" } })).status,
    ).toBe("unreadable");
    expect(
      interpretProposalJob(proposalRow({ result: { content: '{"fields":"nope"}' } })).status,
    ).toBe("unreadable");
    expect(interpretProposalJob(proposalRow({ result: null })).status).toBe("unreadable");
  });

  // A model that wrapped the values in prose has not produced a fixture. The
  // proposal is still usable; the fixture half is simply absent.
  it("drops sample values that are not a JSON object rather than failing the proposal", () => {
    const outcome = interpretProposalJob(
      proposalRow({
        result: {
          content: JSON.stringify({ ...PROPOSAL, sample_values_json: "não consegui ler" }),
        },
      }),
    );
    expect(outcome.status).toBe("ready");
    if (outcome.status !== "ready") return;
    expect(outcome.proposal.sampleValuesJson).toBeNull();
  });
});
