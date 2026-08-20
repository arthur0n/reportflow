// api/trpc/routers/jobs.router.test.ts
//
// The poll backstop (decisions §4.1). Two properties, and the second is the
// reason this file also drives the collector Lambda:
//
//   1. WIRING — a settled row is returned without touching S3, a pending row
//      with no result is returned unchanged, and `request` never leaves the API.
//   2. ONE CODE PATH — the poll and the Lambda call THE SAME `collectResult`,
//      not two implementations of "move a result into the database". §4.1:
//      "idempotency lives in the collector, in one place." The last case below
//      proves it by driving both entry points against a single mock and
//      showing both calls land on the same spy — which is only possible if
//      both import the same module.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { S3Event } from "aws-lambda";
import type * as RelayModule from "../../lib/relay";
import type * as JobStateModule from "../../collector/job-state";

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

const relay = vi.hoisted(() => ({ getRelayJob: vi.fn(), enqueueRelayJob: vi.fn() }));

// parseOutboxKey stays real — reading the jobId back out of the row's s3_key is
// part of what the poll does.
vi.mock("../../lib/relay", async (importOriginal) => {
  const actual = await importOriginal<typeof RelayModule>();
  return { ...actual, ...relay };
});

const state = vi.hoisted(() => ({ loadJobById: vi.fn() }));
vi.mock("../../collector/job-state", async (importOriginal) => {
  const actual = await importOriginal<typeof JobStateModule>();
  return { ...actual, ...state };
});

const collect = vi.hoisted(() => ({ collectResult: vi.fn() }));
vi.mock("../../collector/collect", () => collect);

const { appRouter } = await import("../router");
const { handler: collectorHandler } = await import("../../collector/handler");

const TENANT = "org_2abcTENANT";
const OTHER_TENANT = "org_2zzzOTHER";
const JOB_ID = "3f2b1c8e-5a4d-4e6f-8a9b-0c1d2e3f4a5b-a1";
const ROW_ID = "11111111-1111-4111-8111-111111111111";

const RESULT = { content: '{"total":10}', provider: "gemini", model: "m" };

function jobRow(over: Record<string, unknown> = {}) {
  return {
    id: ROW_ID,
    tenantId: TENANT,
    kind: "extract",
    status: "pending",
    s3Key: `jobs/${TENANT}/${JOB_ID}.json`,
    attempt: 1,
    error: null,
    request: { channel: "ai", system: "não mostre isto ao cliente" },
    result: null,
    documentId: null,
    reportId: null,
    ...over,
  };
}

function caller(tenantId = TENANT) {
  return appRouter.createCaller({ tenantId, userId: "user-1", role: "member" });
}

beforeEach(() => {
  relay.getRelayJob.mockReset().mockResolvedValue({ status: "ready", result: RESULT });
  relay.enqueueRelayJob.mockReset();
  state.loadJobById.mockReset().mockResolvedValue(jobRow());
  collect.collectResult.mockReset().mockResolvedValue({ action: "settled", status: "done" });
});

describe("jobs.poll", () => {
  it("refuses a job id that is not this tenant's", async () => {
    state.loadJobById.mockResolvedValue(undefined);
    await expect(caller().jobs.poll({ id: ROW_ID })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(relay.getRelayJob).not.toHaveBeenCalled();
  });

  it("reads the row under the caller's own tenant", async () => {
    await caller(OTHER_TENANT).jobs.poll({ id: ROW_ID });
    expect(state.loadJobById).toHaveBeenCalledWith(expect.anything(), OTHER_TENANT, ROW_ID);
  });

  // The happy path in production: the collector already moved it, so the poll
  // is a plain read and never touches S3.
  it("returns a settled row without reading S3", async () => {
    state.loadJobById.mockResolvedValue(jobRow({ status: "done" }));
    const out = await caller().jobs.poll({ id: ROW_ID });
    expect(out.status).toBe("done");
    expect(relay.getRelayJob).not.toHaveBeenCalled();
    expect(collect.collectResult).not.toHaveBeenCalled();
  });

  it("returns a pending row unchanged while the relay is still working", async () => {
    relay.getRelayJob.mockResolvedValue({ status: "pending" });
    const out = await caller().jobs.poll({ id: ROW_ID });
    expect(out.status).toBe("pending");
    expect(collect.collectResult).not.toHaveBeenCalled();
  });

  // THE backstop: the result is in S3 and nobody has moved it — a dropped
  // notification, or `pnpm dev:api`, where no S3 event exists at all.
  it("collects a result the collector has not picked up, then re-reads the row", async () => {
    state.loadJobById
      .mockResolvedValueOnce(jobRow())
      .mockResolvedValueOnce(jobRow({ status: "done" }));
    const out = await caller().jobs.poll({ id: ROW_ID });
    expect(collect.collectResult).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TENANT,
      jobId: JOB_ID,
      result: RESULT,
    });
    expect(out.status).toBe("done");
  });

  // DEFECT 1, poll half. A body nobody can read must SETTLE the row here too —
  // left to throw, this endpoint errors on every refetch of a job that can
  // never move, reporting the wedge instead of clearing it.
  it("settles an unreadable result instead of erroring on every refetch", async () => {
    relay.getRelayJob.mockResolvedValue({ status: "malformed", reason: "corpo não é JSON" });
    state.loadJobById
      .mockResolvedValueOnce(jobRow())
      .mockResolvedValueOnce(jobRow({ status: "revisar", error: "resultado ilegível" }));
    const out = await caller().jobs.poll({ id: ROW_ID });
    const input = collect.collectResult.mock.calls[0]?.[1] as { result: unknown };
    expect(input.result).toMatchObject({ error: { type: "permanent" } });
    expect(out.status).toBe("revisar");
  });

  // Catches: reasoning about the outcome instead of re-reading. The collector
  // may have settled the row, retried it, or lost the race to the Lambda — in
  // every case the ROW is the answer, and it is the only thing the UI polls.
  it("reports whatever the row says after collection, even on a lost race", async () => {
    collect.collectResult.mockResolvedValue({ action: "lost-race" });
    state.loadJobById
      .mockResolvedValueOnce(jobRow())
      .mockResolvedValueOnce(jobRow({ status: "revisar", error: "falhou" }));
    const out = await caller().jobs.poll({ id: ROW_ID });
    expect(out.status).toBe("revisar");
  });

  // The canonical job payload is the system prompt, the field list and the
  // model choice. The browser has no use for it and must never see it.
  it("never returns the stored request payload", async () => {
    state.loadJobById.mockResolvedValue(jobRow({ status: "done", result: RESULT }));
    const out = await caller().jobs.poll({ id: ROW_ID });
    expect("request" in out).toBe(false);
    expect(out.result).toEqual(RESULT);
  });

  // A row whose key names another tenant is a bug in whatever wrote it. The
  // poll must not follow it into S3 — the tenant in the key is the tenant the
  // collector would then trust.
  it("refuses to collect from a key that names a different tenant", async () => {
    state.loadJobById.mockResolvedValue(jobRow({ s3Key: `jobs/${OTHER_TENANT}/${JOB_ID}.json` }));
    const out = await caller().jobs.poll({ id: ROW_ID });
    expect(out.status).toBe("pending");
    expect(relay.getRelayJob).not.toHaveBeenCalled();
    expect(collect.collectResult).not.toHaveBeenCalled();
  });

  it("reports a row with an unparseable key instead of throwing on every poll", async () => {
    state.loadJobById.mockResolvedValue(jobRow({ s3Key: "garbage" }));
    await expect(caller().jobs.poll({ id: ROW_ID })).resolves.toMatchObject({ status: "pending" });
  });
});

describe("the two writers", () => {
  // §4.1 — "idempotency lives in the collector, in one place". Both entry
  // points land on the SAME spy, which can only happen if both import the same
  // module. A second implementation on the poll side would leave this at one
  // call and pass every other test in this file.
  it("run the identical processing function, not two implementations of it", async () => {
    await caller().jobs.poll({ id: ROW_ID });
    await collectorHandler({
      Records: [
        {
          s3: {
            bucket: { name: "reportflow-docs-prod" },
            object: { key: `results/${TENANT}/${JOB_ID}.json` },
          },
        },
      ],
    } as S3Event);

    expect(collect.collectResult).toHaveBeenCalledTimes(2);
    const [fromPoll, fromLambda] = collect.collectResult.mock.calls;
    expect(fromPoll?.[1]).toEqual(fromLambda?.[1]);
    // …and both handed in the same enqueue, so a retry costs the same either way.
    expect((fromPoll?.[0] as { enqueue: unknown }).enqueue).toBe(
      (fromLambda?.[0] as { enqueue: unknown }).enqueue,
    );
  });
});
