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

import { describe, it, expect, vi } from "vitest";

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

const { mintJobId, parseJobId, nextAttemptJobId, jobKeyFor, resultKeyFor } =
  await import("./relay");

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
