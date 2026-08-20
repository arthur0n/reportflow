// api/collector/collect.test.ts
//
// The one code path both writers run (decisions §4.1). What is under test here
// is the DECISION — which outcome a given result produces, and what it costs —
// so the state machine and the extraction store are mocked: their SQL is proven
// in job-state.test.ts and their conflict handling in extraction-store.test.ts,
// and mocking them here is what lets a case assert "this did NOT enqueue a
// second paid attempt" rather than inspecting a query builder.
//
// api/lib/relay.ts is deliberately NOT mocked apart from its S3 client: the
// jobId/key derivation is pure, it is the thing that carries the attempt
// number, and a mocked `nextAttemptJobId` would hide the §12.1 bug where a
// retry mints a fresh uuid and orphans the stale-attempt check.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type * as JobStateModule from "./job-state";

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    public readonly send = vi.fn();
  },
  GetObjectCommand: class {
    public constructor(public readonly input: unknown) {}
  },
  PutObjectCommand: class {
    public constructor(public readonly input: unknown) {}
  },
}));

const state = vi.hoisted(() => ({
  transition: vi.fn(),
  casAttempt: vi.fn(),
  confirmEnqueue: vi.fn(),
  loadJobByS3Key: vi.fn(),
}));

/** The marker and its predicate are NOT mocked — they are the thing that tells
 * a wedged retry apart from a healthy one, and a stub would decide the answer. */
vi.mock("./job-state", async (importOriginal) => {
  const actual = await importOriginal<typeof JobStateModule>();
  return {
    ...state,
    MAX_ATTEMPTS: 2,
    ENQUEUE_PENDING_MARKER: actual.ENQUEUE_PENDING_MARKER,
    isAwaitingEnqueue: actual.isAwaitingEnqueue,
  };
});

const store = vi.hoisted(() => ({
  resolveExtractionTarget: vi.fn(),
  insertExtractionIdempotent: vi.fn(),
}));

vi.mock("./extraction-store", () => store);

const { collectResult } = await import("./collect");
const { ENQUEUE_PENDING_MARKER } = await import("./job-state");

const TENANT = "org_2abcTENANT";
const BASE = "3f2b1c8e-5a4d-4e6f-8a9b-0c1d2e3f4a5b";
const JOB_A1 = `${BASE}-a1`;
const JOB_A2 = `${BASE}-a2`;
const ROW_ID = "11111111-1111-4111-8111-111111111111";
const DOC_ID = "22222222-2222-4222-8222-222222222222";

/** The frozen field list `SUCCESS` is validated against (§3.1). Deliberately
 * the REAL `validateExtraction` runs over it — shared/validation is not mocked
 * here, because the property under test in the two cases below is precisely
 * that an invalid payload takes the retry road and a valid one does not, and a
 * stubbed validator would be the thing deciding that. */
const FIELDS = [{ name: "total", type: "integer", required: true, description: "total" }];

const TEMPLATE_ID = "33333333-3333-4333-8333-333333333333";

/**
 * The canonical job payload the API enqueued (§6), as stored on the row.
 *
 * It carries the TEMPLATE BINDING (`extractTemplate`) the collector judges the
 * answer by — the frozen list as the model saw it, plus the calibration
 * generation it was built for (codex review, 2026-08-20).
 * api/extraction/extract-job.ts is deliberately NOT mocked: its reader is what
 * decides whether a stored row is usable at all, and a stub would answer that
 * question for it.
 */
function request(over: Record<string, unknown> = {}) {
  return {
    channel: "ai",
    kind: "extract",
    tenantId: TENANT,
    provider: "gemini",
    extractTemplate: { templateId: TEMPLATE_ID, calibrationRev: 1, fields: FIELDS },
    ...over,
  };
}

const REQUEST = request();

/** A job row whose stored payload declares `fields` as its frozen list — the
 * one axis every §4.2 validation case below varies. */
function rowWithFields(fields: unknown[], over: Record<string, unknown> = {}) {
  return jobRow({
    request: request({
      extractTemplate: { templateId: TEMPLATE_ID, calibrationRev: 1, fields },
    }),
    ...over,
  });
}

const SUCCESS = {
  content: '{"total":10}',
  usage: { input_tokens: 1, output_tokens: 1 },
  model: "gemini-2.5-pro",
  provider: "gemini",
};

const TRANSIENT = { error: { type: "transient", message: "429 from provider" } };
const PERMANENT = { error: { type: "permanent", message: "unknown provider" } };

const TARGET = {
  documentId: DOC_ID,
  extractTemplateId: TEMPLATE_ID,
  s3Key: `${TENANT}/doc.pdf`,
  calibrationRev: 1,
};

function jobRow(over: Record<string, unknown> = {}) {
  return {
    id: ROW_ID,
    tenantId: TENANT,
    kind: "extract",
    status: "pending",
    s3Key: `jobs/${TENANT}/${JOB_A1}.json`,
    attempt: 1,
    error: null,
    request: REQUEST,
    result: null,
    documentId: DOC_ID,
    reportId: null,
    ...over,
  };
}

const enqueue = vi.fn();
const deps = { db: {} as never, enqueue };

function collect(result: unknown, jobId = JOB_A1) {
  return collectResult(deps, { tenantId: TENANT, jobId, result });
}

/** The status a `transition` call was asked to move the row to. */
function transitionedTo(): string | undefined {
  const args = state.transition.mock.calls[0]?.[1] as { to?: string } | undefined;
  return args?.to;
}

beforeEach(() => {
  state.transition.mockReset().mockResolvedValue(true);
  state.casAttempt.mockReset().mockResolvedValue(true);
  state.confirmEnqueue.mockReset().mockResolvedValue(true);
  state.loadJobByS3Key.mockReset().mockResolvedValue(jobRow());
  store.resolveExtractionTarget.mockReset().mockResolvedValue(TARGET);
  store.insertExtractionIdempotent.mockReset().mockResolvedValue({ created: true });
  enqueue.mockReset().mockResolvedValue(undefined);
});

describe("the guards (a duplicate delivery must be free)", () => {
  // The tenant comes from the KEY and is carried into the lookup; the row is
  // found by the JOB key derived from the same parts, never by the result key.
  it("looks the row up by the job key under the key's own tenant", async () => {
    await collect(SUCCESS);
    expect(state.loadJobByS3Key).toHaveBeenCalledWith({}, TENANT, `jobs/${TENANT}/${JOB_A1}.json`);
  });

  // S3 ObjectCreated is at-least-once. This is the redelivery that arrives
  // after the first one already finished.
  it("no-ops on a delivery for a row that is already settled", async () => {
    state.loadJobByS3Key.mockResolvedValue(jobRow({ status: "done" }));
    await expect(collect(SUCCESS)).resolves.toEqual({
      action: "skipped",
      reason: "already-settled",
    });
    expect(state.transition).not.toHaveBeenCalled();
    expect(store.insertExtractionIdempotent).not.toHaveBeenCalled();
  });

  it("no-ops on a delivery for a row a human already repaired", async () => {
    state.loadJobByS3Key.mockResolvedValue(jobRow({ status: "revisar" }));
    await expect(collect(SUCCESS)).resolves.toMatchObject({ reason: "already-settled" });
    expect(state.transition).not.toHaveBeenCalled();
  });

  // §12.1's stale-attempt rejection. The row has moved on to attempt 2; the
  // late result for attempt 1 must not settle it, or the retry that is still in
  // flight lands on a `done` row.
  it("rejects a result whose attempt the row has already superseded", async () => {
    state.loadJobByS3Key.mockResolvedValue(jobRow({ attempt: 2 }));
    await expect(collect(SUCCESS, JOB_A1)).resolves.toEqual({
      action: "skipped",
      reason: "stale-attempt",
    });
    expect(state.transition).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  // The mirror case: an answer for an attempt this row never enqueued.
  it("rejects a result from an attempt ahead of the row", async () => {
    state.loadJobByS3Key.mockResolvedValue(jobRow({ attempt: 1 }));
    await expect(collect(SUCCESS, JOB_A2)).resolves.toMatchObject({ reason: "stale-attempt" });
  });

  it("skips a result whose row does not exist yet", async () => {
    state.loadJobByS3Key.mockResolvedValue(undefined);
    await expect(collect(SUCCESS)).resolves.toEqual({ action: "skipped", reason: "no-job-row" });
  });

  // A foreign object under results/. It must not even reach the database.
  it("skips an object whose name is not one of our jobIds", async () => {
    await expect(collect(SUCCESS, "not-a-job-id")).resolves.toEqual({
      action: "skipped",
      reason: "unparseable-job-id",
    });
    expect(state.loadJobByS3Key).not.toHaveBeenCalled();
  });
});

describe("extract results", () => {
  it("caches the extraction and flips the job to done", async () => {
    await expect(collect(SUCCESS)).resolves.toEqual({ action: "settled", status: "done" });
    expect(store.insertExtractionIdempotent).toHaveBeenCalledWith(
      {},
      TENANT,
      TARGET,
      { total: 10 },
      { provider: "gemini", model: "gemini-2.5-pro" },
    );
    expect(transitionedTo()).toBe("done");
  });

  // ORDER IS THE IDEMPOTENCY: if the process dies between the two, the row is
  // still pending and the next delivery re-runs the insert as a no-op. The
  // reverse order can leave a `done` job with nothing cached behind it.
  it("writes the extraction BEFORE it moves the status", async () => {
    const order: string[] = [];
    store.insertExtractionIdempotent.mockImplementation(async () => {
      order.push("extraction");
      return { created: true };
    });
    state.transition.mockImplementation(async () => {
      order.push("status");
      return true;
    });
    await collect(SUCCESS);
    expect(order).toEqual(["extraction", "status"]);
  });

  // The second writer's insert conflicts and does nothing — which is success,
  // because the artifact this job existed to produce exists.
  it("still completes when the extraction was already cached", async () => {
    store.insertExtractionIdempotent.mockResolvedValue({ created: false });
    await expect(collect(SUCCESS)).resolves.toEqual({ action: "settled", status: "done" });
  });

  // A configuration problem, not a model problem: another paid extraction would
  // land on the same missing row.
  it("sends a document with no live extract template straight to revisar", async () => {
    store.resolveExtractionTarget.mockResolvedValue(null);
    await expect(collect(SUCCESS)).resolves.toEqual({ action: "settled", status: "revisar" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("sends an extract job with no document to revisar", async () => {
    state.loadJobByS3Key.mockResolvedValue(jobRow({ documentId: null }));
    await expect(collect(SUCCESS)).resolves.toEqual({ action: "settled", status: "revisar" });
    expect(store.resolveExtractionTarget).not.toHaveBeenCalled();
  });

  it("never writes an extraction from an error result", async () => {
    await collect(TRANSIENT);
    expect(store.insertExtractionIdempotent).not.toHaveBeenCalled();
  });

  // §4.2's fork, and the reason it lives in this file: an extraction that
  // fails the frozen field list takes the SAME road as a relay failure —
  // "most schema violations are transient" — which means it spends the one
  // retry this file owns.
  it("retries once when the payload fails the frozen field list", async () => {
    state.loadJobByS3Key.mockResolvedValue(
      rowWithFields([
        { name: "total", type: "integer", required: true, description: "total" },
        { name: "data", type: "date", required: true, description: "emissão" },
      ]),
    );
    await expect(collect(SUCCESS)).resolves.toEqual({
      action: "retried",
      jobId: JOB_A2,
      attempt: 2,
    });
    expect(enqueue).toHaveBeenCalledOnce();
  });

  // Nothing invalid is ever cached: `extractions.data` is what hop 2 reads,
  // and an invalid row there is a garbage analysis waiting for the first
  // caller who forgets to check a status. The paid read survives on
  // `report_jobs.result`, which the transition writes.
  it("caches nothing when the payload fails the frozen field list", async () => {
    state.loadJobByS3Key.mockResolvedValue(
      rowWithFields([{ name: "total", type: "money", required: true, description: "total" }]),
    );
    await collect(SUCCESS);
    expect(store.insertExtractionIdempotent).not.toHaveBeenCalled();
  });

  // Second attempt, same violation: the ceiling is reached and a HUMAN is the
  // next step — `revisar`, not `failed`, because there is a per-field repair
  // to offer.
  it("lands an invalid payload in revisar once the retry is spent", async () => {
    state.loadJobByS3Key.mockResolvedValue(
      rowWithFields([{ name: "total", type: "money", required: true, description: "total" }], {
        attempt: 2,
        s3Key: `jobs/${TENANT}/${JOB_A2}.json`,
      }),
    );
    await expect(collect(SUCCESS, JOB_A2)).resolves.toEqual({
      action: "settled",
      status: "revisar",
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(store.insertExtractionIdempotent).not.toHaveBeenCalled();
  });

  // A required field the model simply did not return — §4.2's other half of
  // the same condition ("Zod valid AND all required fields present").
  it("treats a missing required field as invalid", async () => {
    state.loadJobByS3Key.mockResolvedValue(
      rowWithFields([
        { name: "total", type: "integer", required: true, description: "total" },
        { name: "iva", type: "money", required: true, description: "iva" },
      ]),
    );
    await expect(collect(SUCCESS)).resolves.toMatchObject({ action: "retried" });
  });
});

// ---------------------------------------------------------------------------
// §12.8's invalidate semantics, meeting a job that was already in flight
// (codex review, 2026-08-20). A human freezes rev N+1 while a rev-N extraction
// is out at the provider; the result comes back ~30s later.
// ---------------------------------------------------------------------------

describe("a template recalibrated while the extraction was in flight", () => {
  it("judges the answer by the list the MODEL saw, not by the live one", async () => {
    // The live template has moved to rev 2 and would demand a second field.
    // The job's own list has one. The answer satisfies the job's list, so it
    // must not be reported as invalid — the model was never shown the new one.
    store.resolveExtractionTarget.mockResolvedValue({ ...TARGET, calibrationRev: 2 });

    const outcome = await collect(SUCCESS);

    expect(outcome).toEqual({ action: "settled", status: "revisar" });
    // Not a retry: nothing about the ANSWER was wrong, so §4.2's one retry is
    // not spent on it.
    expect(enqueue).not.toHaveBeenCalled();
  });

  // "Recalibrating a document type marks existing extractions for that type
  // stale" — an answer produced under the previous generation is stale BY
  // DEFINITION, so it is not cached under either rev.
  it("caches nothing and settles revisar with a re-run instruction", async () => {
    store.resolveExtractionTarget.mockResolvedValue({ ...TARGET, calibrationRev: 2 });

    await collect(SUCCESS);

    expect(store.insertExtractionIdempotent).not.toHaveBeenCalled();
    const patch = state.transition.mock.calls[0]?.[1] as { patch?: { error?: string } };
    expect(patch.patch?.error).toBe("template recalibrado durante a extração; re-execute");
  });

  // Calibrate REPLACES rather than forks, so a soft-delete plus a fresh insert
  // changes the template id while the rev could plausibly repeat. Comparing
  // only the rev would let that answer through.
  it("refuses a different template id even at the same rev", async () => {
    store.resolveExtractionTarget.mockResolvedValue({
      ...TARGET,
      extractTemplateId: "99999999-9999-4999-8999-999999999999",
    });
    await expect(collect(SUCCESS)).resolves.toEqual({ action: "settled", status: "revisar" });
    expect(store.insertExtractionIdempotent).not.toHaveBeenCalled();
  });

  it("stores normally when the template has not moved", async () => {
    await expect(collect(SUCCESS)).resolves.toEqual({ action: "settled", status: "done" });
    expect(store.insertExtractionIdempotent).toHaveBeenCalledOnce();
  });

  // No fallback to a live read: a live read IS the race. A row that cannot say
  // which list it was built from is a row nobody can grade.
  it("sends a job with no stored field list to revisar rather than reading live rows", async () => {
    state.loadJobByS3Key.mockResolvedValue(jobRow({ request: { channel: "ai", kind: "extract" } }));
    await expect(collect(SUCCESS)).resolves.toEqual({ action: "settled", status: "revisar" });
    expect(store.resolveExtractionTarget).not.toHaveBeenCalled();
    expect(store.insertExtractionIdempotent).not.toHaveBeenCalled();
  });

  it("refuses a stored field list that did not survive the jsonb round trip", async () => {
    state.loadJobByS3Key.mockResolvedValue(rowWithFields(["total"]));
    await expect(collect(SUCCESS)).resolves.toEqual({ action: "settled", status: "revisar" });
    expect(store.insertExtractionIdempotent).not.toHaveBeenCalled();
  });
});

describe("the retry-once path (§4.2)", () => {
  // The retry keeps the BASE and bumps only the attempt — that is what lets the
  // stale-attempt check recognise the two results as being about one job.
  it("bumps the row and enqueues attempt 2 with the stored payload", async () => {
    await expect(collect(TRANSIENT)).resolves.toEqual({
      action: "retried",
      jobId: JOB_A2,
      attempt: 2,
    });
    expect(state.casAttempt).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        tenantId: TENANT,
        id: ROW_ID,
        fromAttempt: 1,
        toAttempt: 2,
        s3Key: `jobs/${TENANT}/${JOB_A2}.json`,
      }),
    );
    expect(enqueue).toHaveBeenCalledWith(TENANT, JOB_A2, REQUEST);
    expect(state.transition).not.toHaveBeenCalled();
  });

  // §4.2 — "most schema violations are transient". Structured output that is
  // not JSON takes the same path as a relay failure.
  it("retries a success whose payload is not usable JSON", async () => {
    await expect(collect({ ...SUCCESS, content: "Claro! Aqui está:" })).resolves.toMatchObject({
      action: "retried",
    });
    expect(enqueue).toHaveBeenCalledOnce();
  });

  // ONCE, not forever. The ceiling is the whole reason the attempt is in the
  // key rather than in a counter somebody has to remember to increment.
  it("stops at the ceiling and lands in revisar", async () => {
    state.loadJobByS3Key.mockResolvedValue(jobRow({ attempt: 2 }));
    await expect(collect(TRANSIENT, JOB_A2)).resolves.toEqual({
      action: "settled",
      status: "revisar",
    });
    expect(enqueue).not.toHaveBeenCalled();
  });

  // relay/src/errors.ts: "`permanent` is a refusal of that invitation". Paying
  // for a call that will fail identically is exactly what the classification is
  // there to prevent.
  it("does not retry a failure the relay classified as permanent", async () => {
    await expect(collect(PERMANENT)).resolves.toEqual({ action: "settled", status: "revisar" });
    expect(enqueue).not.toHaveBeenCalled();
    expect(state.casAttempt).not.toHaveBeenCalled();
  });

  // The relay deletes jobs/{…}.json when it writes the result, so the row is
  // the only surviving copy of the payload. Without one, nobody can retry.
  it("cannot retry a row with no stored request, and says so", async () => {
    state.loadJobByS3Key.mockResolvedValue(jobRow({ request: null }));
    await expect(collect(TRANSIENT)).resolves.toEqual({ action: "settled", status: "revisar" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  // Two writers reading the same failed result. Only the one that wins the
  // compare-and-set may spend money on another provider call.
  it("does not enqueue when it loses the attempt bump", async () => {
    state.casAttempt.mockResolvedValue(false);
    await expect(collect(TRANSIENT)).resolves.toEqual({ action: "lost-race" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  // Catches the wedge: a row bumped to attempt 2 pointing at a job object that
  // was never written, with every redelivery of attempt 1's result now rejected
  // as stale — pending forever, which is what the collector exists to prevent.
  it("rolls the attempt back when the enqueue fails, then rethrows", async () => {
    enqueue.mockRejectedValue(new Error("s3 down"));
    await expect(collect(TRANSIENT)).rejects.toThrow("s3 down");
    expect(state.casAttempt).toHaveBeenCalledTimes(2);
    expect(state.casAttempt.mock.calls[1]?.[1]).toMatchObject({
      fromAttempt: 2,
      toAttempt: 1,
      s3Key: `jobs/${TENANT}/${JOB_A1}.json`,
    });
    // The rollback landed, so there is nothing to escalate.
    expect(state.transition).not.toHaveBeenCalled();
  });

  // The bump is marked until the outbox write is CONFIRMED. Without the marker,
  // a wedged row and a healthy in-flight retry are the same row.
  it("marks the row while the enqueue is unconfirmed and clears it after", async () => {
    await collect(TRANSIENT);
    const bump = state.casAttempt.mock.calls[0]?.[1] as { error: string };
    expect(bump.error.startsWith(ENQUEUE_PENDING_MARKER)).toBe(true);
    expect(state.confirmEnqueue).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ id: ROW_ID, attempt: 2 }),
    );
    const confirmed = state.confirmEnqueue.mock.calls[0]?.[1] as { error: string };
    expect(confirmed.error.startsWith(ENQUEUE_PENDING_MARKER)).toBe(false);
  });

  it("clears the marker only after the enqueue actually succeeded", async () => {
    enqueue.mockRejectedValue(new Error("s3 down"));
    await expect(collect(TRANSIENT)).rejects.toThrow("s3 down");
    expect(state.confirmEnqueue).not.toHaveBeenCalled();
  });
});

// DEFECT 2. Bump lands, PutObject fails, and the compensating rollback ALSO
// fails (the row moved, or RDS is unreachable). Before this, the row sat
// `pending` at attempt n+1 pointing at a job object nobody wrote, and every
// later delivery of attempt n's result was rejected as stale — wedged forever,
// invisible, already paid for.
describe("when the retry can be neither enqueued nor rolled back", () => {
  beforeEach(() => {
    enqueue.mockRejectedValue(new Error("s3 down"));
    // First call is the bump (succeeds), second is the rollback (fails).
    state.casAttempt.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  });

  it("escalates the row to a terminal status at the bumped attempt", async () => {
    await expect(collect(TRANSIENT)).rejects.toThrow("s3 down");
    expect(state.transition).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        id: ROW_ID,
        from: "pending",
        to: "revisar",
        attempt: 2,
      }),
    );
    const args = state.transition.mock.calls[0]?.[1] as { patch?: { error?: string } };
    expect(args.patch?.error).toBe(
      "não foi possível reenfileirar a tentativa; intervenção necessária",
    );
  });

  it("escalates a non-extract job to failed rather than revisar", async () => {
    state.loadJobByS3Key.mockResolvedValue(jobRow({ kind: "analyse" }));
    await expect(collect(TRANSIENT)).rejects.toThrow("s3 down");
    expect((state.transition.mock.calls[0]?.[1] as { to: string }).to).toBe("failed");
  });

  // A rollback that THROWS (RDS down) must not mask the escalation, and the
  // escalation throwing must not mask the original error.
  it("survives a rollback that throws and still escalates", async () => {
    state.casAttempt
      .mockReset()
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("rds"));
    await expect(collect(TRANSIENT)).rejects.toThrow("s3 down");
    expect(state.transition).toHaveBeenCalledOnce();
  });

  it("rethrows the original failure when even the escalation cannot land", async () => {
    state.transition.mockRejectedValue(new Error("rds"));
    await expect(collect(TRANSIENT)).rejects.toThrow("s3 down");
  });
});

// The second half of the fix: the redelivery that arrives AFTER the process
// died before it could unwind.
describe("recovering a row stranded at an un-enqueued attempt", () => {
  /** Pending at attempt 2, still carrying the marker: bumped, never enqueued. */
  function wedged(over: Record<string, unknown> = {}) {
    return jobRow({
      attempt: 2,
      status: "pending",
      error: `${ENQUEUE_PENDING_MARKER} tentativa 1: 429 from provider`,
      s3Key: `jobs/${TENANT}/${JOB_A2}.json`,
      ...over,
    });
  }

  it("escalates on the redelivery of the stale failure instead of skipping", async () => {
    state.loadJobByS3Key.mockResolvedValue(wedged());
    await expect(collect(TRANSIENT, JOB_A1)).resolves.toEqual({
      action: "settled",
      status: "revisar",
    });
    expect(state.transition).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ from: "pending", to: "revisar", attempt: 2 }),
    );
  });

  // THE case that makes the marker necessary. Same row shape, same stale
  // result, but the retry WAS enqueued and is running — killing it here would
  // throw away a live, already-paid attempt every time S3 redelivers, which it
  // is entitled to do at any moment.
  it("leaves a healthy in-flight retry alone", async () => {
    state.loadJobByS3Key.mockResolvedValue(wedged({ error: "tentativa 1: 429 from provider" }));
    await expect(collect(TRANSIENT, JOB_A1)).resolves.toEqual({
      action: "skipped",
      reason: "stale-attempt",
    });
    expect(state.transition).not.toHaveBeenCalled();
  });

  it("leaves a row alone when the gap is more than one attempt", async () => {
    state.loadJobByS3Key.mockResolvedValue(wedged({ attempt: 3 }));
    await expect(collect(TRANSIENT, JOB_A1)).resolves.toMatchObject({ reason: "stale-attempt" });
    expect(state.transition).not.toHaveBeenCalled();
  });

  it("does not escalate on a stale SUCCESS — only a failure can have bumped a row", async () => {
    state.loadJobByS3Key.mockResolvedValue(wedged());
    await expect(collect(SUCCESS, JOB_A1)).resolves.toMatchObject({ reason: "stale-attempt" });
    expect(state.transition).not.toHaveBeenCalled();
  });

  // (The attempt guard is checked before the status guard, so a settled row on
  // a superseded attempt reports stale-attempt. Either skip is correct; what
  // matters is that nothing tries to move a row a human may already have fixed.)
  it("does not escalate a row that is already settled", async () => {
    state.loadJobByS3Key.mockResolvedValue(wedged({ status: "done" }));
    await expect(collect(TRANSIENT, JOB_A1)).resolves.toMatchObject({ action: "skipped" });
    expect(state.transition).not.toHaveBeenCalled();
  });

  // Two writers can reach the escalation at once. The CAS decides, and the
  // loser falls through to the ordinary skip rather than reporting a settle it
  // did not make.
  it("falls back to the plain stale-skip when it loses the escalation CAS", async () => {
    state.loadJobByS3Key.mockResolvedValue(wedged());
    state.transition.mockResolvedValue(false);
    await expect(collect(TRANSIENT, JOB_A1)).resolves.toEqual({
      action: "skipped",
      reason: "stale-attempt",
    });
  });
});

describe("detect / analyse / verify results", () => {
  it("persists the result verbatim and completes the job", async () => {
    state.loadJobByS3Key.mockResolvedValue(jobRow({ kind: "analyse", documentId: null }));
    await expect(collect(SUCCESS)).resolves.toEqual({ action: "settled", status: "done" });
    const args = state.transition.mock.calls[0]?.[1] as { patch?: { result?: unknown } };
    expect(args.patch?.result).toEqual(SUCCESS);
    expect(store.insertExtractionIdempotent).not.toHaveBeenCalled();
  });

  it("does not care whether the analysis content is JSON", async () => {
    state.loadJobByS3Key.mockResolvedValue(jobRow({ kind: "analyse" }));
    await expect(collect({ ...SUCCESS, content: "Prosa em português." })).resolves.toEqual({
      action: "settled",
      status: "done",
    });
  });

  // `revisar` means a human can fix it HERE — and the field-by-field repair
  // screen only exists for an extraction. A dead analyse hop is `failed`.
  it("fails rather than revisar, because there is no per-field repair to offer", async () => {
    state.loadJobByS3Key.mockResolvedValue(jobRow({ kind: "verify" }));
    await expect(collect(PERMANENT)).resolves.toEqual({ action: "settled", status: "failed" });
    state.transition.mockClear();
    state.loadJobByS3Key.mockResolvedValue(jobRow({ kind: "detect", attempt: 2 }));
    await expect(collect(TRANSIENT, JOB_A2)).resolves.toEqual({
      action: "settled",
      status: "failed",
    });
  });

  it("retries a transient analyse failure exactly like an extract one", async () => {
    state.loadJobByS3Key.mockResolvedValue(jobRow({ kind: "analyse" }));
    await expect(collect(TRANSIENT)).resolves.toMatchObject({ action: "retried" });
  });
});

describe("losing the settle race", () => {
  // The other writer settled the row between this one's read and its write.
  // Postgres decides it, and the loser is told — it does not retry the write.
  it("reports lost-race rather than forcing the status", async () => {
    state.transition.mockResolvedValue(false);
    await expect(collect(SUCCESS)).resolves.toEqual({ action: "lost-race" });
  });

  // The extraction still went in, and that is correct: it is keyed on the
  // artifact, not the job, and ON CONFLICT DO NOTHING makes it a no-op.
  it("still leaves the cached extraction in place", async () => {
    state.transition.mockResolvedValue(false);
    await collect(SUCCESS);
    expect(store.insertExtractionIdempotent).toHaveBeenCalledOnce();
  });
});
