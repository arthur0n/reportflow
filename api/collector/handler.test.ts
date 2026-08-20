// api/collector/handler.test.ts
//
// The Lambda entry is only about DELIVERY SEMANTICS — decode the key, refuse
// what is not ours, read the object, decide what a failure means for the S3
// retry. Everything that decides anything is in ./collect.ts and is mocked
// here, which is the point: if a case in this file starts needing to know what
// a result MEANS, the split has gone wrong.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { S3Event } from "aws-lambda";
import type * as RelayModule from "../lib/relay";

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

const relay = vi.hoisted(() => ({
  getRelayJob: vi.fn(),
  enqueueRelayJob: vi.fn(),
}));

// parseOutboxKey stays REAL: refusing a key that is not ours is the behaviour
// under test in half these cases, and a mocked parser would assert nothing.
vi.mock("../lib/relay", async (importOriginal) => {
  const actual = await importOriginal<typeof RelayModule>();
  return { ...actual, ...relay };
});

const collect = vi.hoisted(() => ({ collectResult: vi.fn() }));
vi.mock("./collect", () => collect);

const { handler } = await import("./handler");

const TENANT = "org_2abcTENANT";
const JOB_ID = "3f2b1c8e-5a4d-4e6f-8a9b-0c1d2e3f4a5b-a1";

function eventFor(...keys: string[]): S3Event {
  return {
    Records: keys.map((key) => ({
      s3: { bucket: { name: "reportflow-docs-prod" }, object: { key } },
    })),
  } as S3Event;
}

beforeEach(() => {
  relay.getRelayJob.mockReset().mockResolvedValue({ status: "ready", result: { content: "{}" } });
  relay.enqueueRelayJob.mockReset();
  collect.collectResult.mockReset().mockResolvedValue({ action: "settled", status: "done" });
});

describe("the collector Lambda", () => {
  it("reads the result and hands it to the shared processing function", async () => {
    await handler(eventFor(`results/${TENANT}/${JOB_ID}.json`));
    expect(relay.getRelayJob).toHaveBeenCalledWith(TENANT, JOB_ID);
    expect(collect.collectResult).toHaveBeenCalledWith(expect.anything(), {
      tenantId: TENANT,
      jobId: JOB_ID,
      result: { content: "{}" },
    });
  });

  // The retry of §4.2 is the collector's only S3 write, and it can only happen
  // if the real enqueue is the one that was injected.
  it("injects the real enqueue so the retry path can actually enqueue", async () => {
    await handler(eventFor(`results/${TENANT}/${JOB_ID}.json`));
    const deps = collect.collectResult.mock.calls[0]?.[0] as { enqueue: unknown };
    expect(deps.enqueue).toBe(relay.enqueueRelayJob);
  });

  // Catches: taking record.s3.object.key at face value. S3 percent-encodes it
  // and writes `+` for a space, so an unencoded key finds no row.
  it("decodes the S3 event's key encoding", async () => {
    await handler(eventFor(`results%2F${TENANT}%2F${JOB_ID}.json`));
    expect(relay.getRelayJob).toHaveBeenCalledWith(TENANT, JOB_ID);
  });

  // The notification filters on `results/`, but a filter can be clobbered —
  // `put-bucket-notification-configuration` replaces the whole config. Ignoring
  // rather than throwing is what stops a misfiled trigger becoming an infinite
  // redelivery loop.
  it("ignores an object that is not under results/, without throwing", async () => {
    await expect(handler(eventFor(`jobs/${TENANT}/${JOB_ID}.json`))).resolves.toBeUndefined();
    expect(collect.collectResult).not.toHaveBeenCalled();
    expect(relay.getRelayJob).not.toHaveBeenCalled();
  });

  it("ignores a key that is not three segments under a known prefix", async () => {
    await handler(eventFor(`results/${TENANT}/nested/${JOB_ID}.json`, "results/x.json"));
    expect(collect.collectResult).not.toHaveBeenCalled();
  });

  // A delete or a lifecycle expiry between the event and the read. Nothing to
  // do and nothing to retry.
  it("does nothing when the result object is already gone", async () => {
    relay.getRelayJob.mockResolvedValue({ status: "pending" });
    await expect(handler(eventFor(`results/${TENANT}/${JOB_ID}.json`))).resolves.toBeUndefined();
    expect(collect.collectResult).not.toHaveBeenCalled();
  });

  it("processes every record in a batch", async () => {
    const other = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d-a2";
    await handler(eventFor(`results/${TENANT}/${JOB_ID}.json`, `results/${TENANT}/${other}.json`));
    expect(collect.collectResult).toHaveBeenCalledTimes(2);
  });

  // DEFECT 1, ingress half. Before this the parse threw inside getRelayJob, no
  // CAS was ever reached, and the row stayed pending forever with the
  // unreadable object still in the bucket re-failing every redelivery.
  it("settles the row from an unreadable body instead of throwing", async () => {
    relay.getRelayJob.mockResolvedValue({ status: "malformed", reason: "corpo não é JSON" });
    await expect(handler(eventFor(`results/${TENANT}/${JOB_ID}.json`))).resolves.toBeUndefined();
    expect(collect.collectResult).toHaveBeenCalledOnce();
    const input = collect.collectResult.mock.calls[0]?.[1] as { result: unknown };
    // The SAME envelope shape a relay failure arrives in — one failure path.
    expect(input.result).toMatchObject({ error: { type: "permanent" } });
  });

  // A throw IS the retry (EventInvokeConfig gives it two more chances), and
  // that is only safe because collectResult is idempotent. Swallowing it would
  // turn a transient RDS blip into a permanently lost, already-paid result.
  it("lets a processing failure escape so S3 redelivers", async () => {
    collect.collectResult.mockRejectedValue(new Error("rds unreachable"));
    await expect(handler(eventFor(`results/${TENANT}/${JOB_ID}.json`))).rejects.toThrow(
      "rds unreachable",
    );
  });
});
