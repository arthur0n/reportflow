// relay/src/keys.test.ts
//
// The result key is derived from the PARSED parts of the job key, never by
// substituting a prefix into the incoming string. That was a real bug in the
// sibling project: a job key with extra segments produced a matching result key
// and could be made to write to `results/{victim}/{known-id}.json`, landing
// content where the poller reads it as its own answer.

import { describe, it, expect } from "vitest";
import { parseJobKey, resultKeyFor, claimKeyFor, isSegment } from "./keys";
import { PermanentError } from "./errors";

const TENANT = "org_2abcDEF";
const JOB = "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d-a1";

describe("parseJobKey", () => {
  it("parses jobs/{tenantId}/{jobId}.json", () => {
    expect(parseJobKey(`jobs/${TENANT}/${JOB}.json`)).toEqual({
      tenantId: TENANT,
      jobId: JOB,
    });
  });

  // §12.11 — the relay processes only the jobs/ prefix. Without the filter,
  // every uploaded PDF and every result the relay writes would invoke it.
  it("refuses a key outside the jobs/ prefix", () => {
    expect(() => parseJobKey(`results/${TENANT}/${JOB}.json`)).toThrow(PermanentError);
    expect(() => parseJobKey(`${TENANT}/doc.pdf`)).toThrow(PermanentError);
  });

  // THE case. Catches: checking only the prefix and then substituting it.
  it("refuses a key with extra segments", () => {
    expect(() => parseJobKey(`jobs/${TENANT}/nested/${JOB}.json`)).toThrow(PermanentError);
  });

  it("refuses a malformed tenantId or jobId", () => {
    expect(() => parseJobKey(`jobs/../${JOB}.json`)).toThrow(/malformed/u);
    expect(() => parseJobKey(`jobs/${TENANT}/..json`)).toThrow(PermanentError);
    expect(() => parseJobKey(`jobs/${TENANT}/${JOB}.txt`)).toThrow(/not a \.json/u);
  });
});

describe("resultKeyFor", () => {
  it("derives the result key from the parsed parts", () => {
    expect(resultKeyFor({ tenantId: TENANT, jobId: JOB })).toBe(`results/${TENANT}/${JOB}.json`);
  });

  // A round trip: whatever parseJobKey accepts, resultKeyFor turns into a key
  // that is itself outside the jobs/ prefix, so the relay cannot trigger itself.
  it("never produces a key the relay would consume as a job", () => {
    const key = parseJobKey(`jobs/${TENANT}/${JOB}.json`);
    expect(() => parseJobKey(resultKeyFor(key))).toThrow(PermanentError);
  });
});

describe("claimKeyFor", () => {
  it("derives the claim key from the parsed parts", () => {
    expect(claimKeyFor({ tenantId: TENANT, jobId: JOB })).toBe(`claims/${TENANT}/${JOB}.json`);
  });

  // Catches: a claim key that collides with the result key, which would make
  // taking the claim indistinguishable from answering the job.
  it("is a different key from the result key", () => {
    const key = { tenantId: TENANT, jobId: JOB };
    expect(claimKeyFor(key)).not.toBe(resultKeyFor(key));
  });

  // §12.11 — a claim write must be invisible to the relay's own trigger, or
  // claiming a job would enqueue it again.
  it("never produces a key the relay would consume as a job", () => {
    expect(() => parseJobKey(claimKeyFor({ tenantId: TENANT, jobId: JOB }))).toThrow(
      PermanentError,
    );
  });
});

describe("isSegment", () => {
  it("accepts what a Clerk org id and an attempt-numbered jobId look like", () => {
    expect(isSegment(TENANT)).toBe(true);
    expect(isSegment(JOB)).toBe(true);
  });

  it("rejects anything that could introduce or climb a path level", () => {
    for (const bad of ["a/b", "..", ".", "a.b", "", "a b"]) {
      expect(isSegment(bad)).toBe(false);
    }
  });
});
