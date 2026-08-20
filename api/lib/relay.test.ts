// api/lib/relay.test.ts
//
// The API's half of the outbox contract. The two halves are in different
// bundles and cannot import each other, so the only thing keeping them
// compatible is that both agree on the KEY SHAPE — which is what these cases
// pin. The relay's own copy of the rule is exercised in
// relay/src/keys.test.ts; if either side changes, one of the two suites fails.
//
// No AWS calls: the S3 client is mocked, and the interesting behaviour is the
// key derivation and the attempt numbering, neither of which needs a network.

import { describe, it, expect, beforeEach, vi } from "vitest";

/** Shared so a case can decide what S3 answered. */
const s3 = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    public readonly send = s3.send;
  },
  GetObjectCommand: class {
    public constructor(public readonly input: unknown) {}
  },
  PutObjectCommand: class {
    public constructor(public readonly input: unknown) {}
  },
}));

const {
  mintJobId,
  parseJobId,
  nextAttemptJobId,
  jobKeyFor,
  resultKeyFor,
  parseOutboxKey,
  getRelayJob,
  MAX_RESULT_BYTES,
} = await import("./relay");

const TENANT = "org_2abcDEF";

/** The relay refuses a key segment containing anything else (relay/src/keys.ts).
 * Duplicated here as a LITERAL rather than imported, because the point is that
 * two bundles independently agree. */
const RELAY_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/u;

describe("mintJobId", () => {
  it("produces an id the relay's segment pattern accepts", () => {
    expect(mintJobId()).toMatch(RELAY_SEGMENT);
  });

  it("is unguessable and collision-free across calls", () => {
    const ids = new Set(Array.from({ length: 200 }, () => mintJobId()));
    expect(ids.size).toBe(200);
  });

  // §12.1 — the attempt number has to be legible from the key, so the collector
  // can reject a write from a stale attempt without opening either result file.
  it("carries attempt 1 by default and the attempt it is given otherwise", () => {
    expect(parseJobId(mintJobId())?.attempt).toBe(1);
    expect(parseJobId(mintJobId(3))?.attempt).toBe(3);
  });
});

describe("parseJobId / nextAttemptJobId", () => {
  it("round-trips base and attempt", () => {
    const id = mintJobId(2);
    const parts = parseJobId(id);
    expect(parts).not.toBeNull();
    expect(`${parts?.base ?? ""}-a${String(parts?.attempt ?? 0)}`).toBe(id);
  });

  // THE case for §12.1. Catches: minting a fresh uuid for a retry, which makes
  // the retry a DIFFERENT job that happens to do the same thing — and leaves
  // the collector's stale-attempt check nothing to compare.
  it("keeps the base and bumps only the attempt", () => {
    const first = mintJobId();
    const second = nextAttemptJobId(first);
    expect(parseJobId(second)?.base).toBe(parseJobId(first)?.base);
    expect(parseJobId(second)?.attempt).toBe(2);
    expect(parseJobId(nextAttemptJobId(second))?.attempt).toBe(3);
    expect(second).toMatch(RELAY_SEGMENT);
  });

  // Returns null rather than throwing: a caller reading a jobId is usually
  // deciding whether to trust it, and a throw makes "not ours" look like a bug.
  it("returns null for anything that is not one of our ids", () => {
    for (const bad of [
      "",
      "abc",
      "not-a-uuid-a1",
      `${"x".repeat(36)}-a1`,
      mintJobId().slice(0, -3),
    ]) {
      expect(parseJobId(bad)).toBeNull();
    }
  });

  it("throws when asked to bump something that is not a jobId", () => {
    expect(() => nextAttemptJobId("nope")).toThrow(/not a jobId/u);
  });
});

describe("key derivation", () => {
  it("writes jobs under jobs/{tenantId}/{jobId}.json", () => {
    const id = mintJobId();
    expect(jobKeyFor(TENANT, id)).toBe(`jobs/${TENANT}/${id}.json`);
  });

  it("reads results from results/{tenantId}/{jobId}.json", () => {
    const id = mintJobId();
    expect(resultKeyFor(TENANT, id)).toBe(`results/${TENANT}/${id}.json`);
  });

  // §12.11 — the relay consumes only the jobs/ prefix, and the API is its sole
  // writer. If the result key ever landed under jobs/, the relay would consume
  // its own output in a loop.
  it("never puts a result under the prefix the relay consumes", () => {
    expect(resultKeyFor(TENANT, mintJobId()).startsWith("jobs/")).toBe(false);
  });

  // The three-segment shape is the relay's parse contract. Extra segments are
  // exactly what the relay refuses (relay/src/keys.ts).
  it("produces exactly three segments on both prefixes", () => {
    const id = mintJobId();
    expect(jobKeyFor(TENANT, id).split("/")).toHaveLength(3);
    expect(resultKeyFor(TENANT, id).split("/")).toHaveLength(3);
  });
});

describe("parseOutboxKey", () => {
  // The collector's entry point: an S3 event hands it a key and nothing else,
  // and the tenantId it reads out of that key is the one every query below it
  // is scoped by. A parse that accepted more than the three-segment shape would
  // make that tenantId a value the writer chose.
  it("round-trips both keys this module mints", () => {
    const id = mintJobId();
    expect(parseOutboxKey(jobKeyFor(TENANT, id))).toEqual({
      prefix: "jobs",
      tenantId: TENANT,
      jobId: id,
    });
    expect(parseOutboxKey(resultKeyFor(TENANT, id))).toEqual({
      prefix: "results",
      tenantId: TENANT,
      jobId: id,
    });
  });

  // The traversal case relay/src/keys.ts exists to prevent, restated on this
  // side: a segment containing a slash or a dot is a path expression, not a
  // tenantId.
  it("refuses extra segments, traversal, and foreign prefixes", () => {
    for (const bad of [
      "",
      "results/x.json",
      `results/${TENANT}/nested/${mintJobId()}.json`,
      `results/../${mintJobId()}.json`,
      `results/${TENANT}/${mintJobId()}.txt`,
      `claims/${TENANT}/${mintJobId()}.json`,
      `${TENANT}/${mintJobId()}.pdf`,
    ]) {
      expect(parseOutboxKey(bad)).toBeNull();
    }
  });

  // Returns null rather than throwing: the collector sees every notification
  // the bucket sends it, so "not ours" must be answerable without looking like
  // a fault.
  it("answers null instead of throwing", () => {
    expect(() => parseOutboxKey("nonsense")).not.toThrow();
  });
});

// DEFECT 1. A body that is not JSON used to throw out of here, and a throw
// settles nothing: neither ingress path reaches a compare-and-set, so the row
// stays `pending` forever while the poll errors on every refetch. Every case
// below must ANSWER — the caller turns "malformed" into a terminal status.
describe("getRelayJob on a body it cannot read", () => {
  function bodyOf(text: string, contentLength?: number) {
    return {
      Body: { transformToString: async () => Promise.resolve(text) },
      ContentLength: contentLength ?? text.length,
    };
  }

  beforeEach(() => {
    s3.send.mockReset();
  });

  it("reads a well-formed result", async () => {
    s3.send.mockResolvedValue(bodyOf('{"content":"{}"}'));
    await expect(getRelayJob(TENANT, mintJobId())).resolves.toEqual({
      status: "ready",
      result: { content: "{}" },
    });
  });

  it("still reports a missing object as pending", async () => {
    s3.send.mockRejectedValue(Object.assign(new Error("nope"), { name: "NoSuchKey" }));
    await expect(getRelayJob(TENANT, mintJobId())).resolves.toEqual({ status: "pending" });
  });

  it("answers malformed instead of throwing on a body that is not JSON", async () => {
    s3.send.mockResolvedValue(bodyOf("<!DOCTYPE html><h1>500</h1>"));
    const out = await getRelayJob(TENANT, mintJobId());
    expect(out.status).toBe("malformed");
  });

  it("answers malformed on truncated JSON", async () => {
    s3.send.mockResolvedValue(bodyOf('{"content":"{\\"total\\":1'));
    expect((await getRelayJob(TENANT, mintJobId())).status).toBe("malformed");
  });

  // Checked from ContentLength BEFORE the stream is drained: the point of a cap
  // is not to reject a large string after paying the memory to build it.
  it("refuses an oversized object without reading it", async () => {
    const transformToString = vi.fn();
    s3.send.mockResolvedValue({ Body: { transformToString }, ContentLength: MAX_RESULT_BYTES + 1 });
    expect((await getRelayJob(TENANT, mintJobId())).status).toBe("malformed");
    expect(transformToString).not.toHaveBeenCalled();
  });

  // The backstop for a missing or lying ContentLength.
  it("refuses an oversized body even when the header does not say so", async () => {
    s3.send.mockResolvedValue(bodyOf("x".repeat(MAX_RESULT_BYTES + 1), 10));
    expect((await getRelayJob(TENANT, mintJobId())).status).toBe("malformed");
  });

  it("answers malformed when the stream itself fails", async () => {
    s3.send.mockResolvedValue({
      Body: {
        transformToString: async () => {
          await Promise.resolve();
          throw new Error("connection reset");
        },
      },
      ContentLength: 10,
    });
    expect((await getRelayJob(TENANT, mintJobId())).status).toBe("malformed");
  });

  // Unchanged, and it must stay that way: a permissions or network fault is not
  // a malformed result, and swallowing it would settle a job on a lie.
  it("still rethrows an S3 error that is not a missing key", async () => {
    s3.send.mockRejectedValue(Object.assign(new Error("denied"), { name: "AccessDenied" }));
    await expect(getRelayJob(TENANT, mintJobId())).rejects.toThrow("denied");
  });
});
