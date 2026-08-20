// relay/src/keys.ts
//
// One parse of the incoming object key, and every other key derived from its
// PARTS. Ported from smartstocke/api/relay/relay-handler.ts, including the
// reason it looks like this.
//
// Checking only the `jobs/` prefix was not enough there. The result key used to
// be derived by substituting that prefix, so a key with extra segments produced
// a matching result key and a job could be made to write to
// `results/{victim}/{known-id}.json` — either overwriting a legitimate result
// or racing one, in both cases landing content where the API's poller reads it
// as its own answer. Parsing the whole shape and deriving the other keys from
// the parsed parts removes the class rather than the instance.
//
// The tenantId this yields is the one the whole relay trusts. It comes from the
// KEY, which S3 supplies and the job payload cannot touch, which is what makes
// the checks in job.ts and secrets.ts mean anything: a predicate that
// constrains one side and takes the other side's word for it constrains
// nothing (decisions §12.7, §12.11).

import { PermanentError } from "./errors";

/**
 * A single path segment. No slash, so it cannot introduce a level, and no dot,
 * so it can be neither `.` nor `..`. That is what makes the tenantId in a key a
 * tenantId rather than a path expression.
 *
 * Clerk `org_id`s are `org_` + base58, and jobIds are `{uuid}-a{attempt}`
 * (§12.1) — both fit.
 */
const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/u;

export interface JobKey {
  readonly tenantId: string;
  readonly jobId: string;
}

/** Parses `jobs/{tenantId}/{jobId}.json` and REFUSES anything else. */
export function parseJobKey(jobKey: string): JobKey {
  const parts = jobKey.split("/");
  if (parts.length !== 3 || parts[0] !== "jobs") {
    throw new PermanentError(`job key is not jobs/{tenantId}/{jobId}.json: ${jobKey}`);
  }
  const tenantId = parts[1] ?? "";
  const file = parts[2] ?? "";
  if (!SEGMENT.test(tenantId)) {
    throw new PermanentError(`job key has a malformed tenantId: ${jobKey}`);
  }
  if (!file.endsWith(".json")) {
    throw new PermanentError(`job key is not a .json object: ${jobKey}`);
  }
  const jobId = file.slice(0, -".json".length);
  if (!SEGMENT.test(jobId)) {
    throw new PermanentError(`job key has a malformed jobId: ${jobKey}`);
  }
  return { tenantId, jobId };
}

/**
 * Built from the PARSED parts, never by substituting into the incoming string.
 * Both segments have already been proven to match SEGMENT, so the result cannot
 * contain a slash beyond the two written here and cannot start with `jobs/`.
 */
export function resultKeyFor(key: JobKey): string {
  return `results/${key.tenantId}/${key.jobId}.json`;
}

/**
 * Same derivation, third prefix. The claim is the relay's own bookkeeping and
 * nothing else reads it, which is why it is a separate prefix rather than a
 * flag on the job: the API has no grant here, so it cannot pre-claim a job it
 * enqueued, and the bucket's lifecycle rule expires a leaked claim alongside
 * the jobs and results.
 *
 * Writing here cannot re-trigger the relay: the bucket notification filters on
 * the `jobs/` prefix (§12.11), so `claims/` and `results/` writes are invisible
 * to it.
 */
export function claimKeyFor(key: JobKey): string {
  return `claims/${key.tenantId}/${key.jobId}.json`;
}

/** Whether a segment is safe to interpolate into a derived path (an SSM
 * parameter name, say). Same rule, exported so secrets.ts does not grow a
 * second, subtly different copy of it. */
export function isSegment(value: string): boolean {
  return SEGMENT.test(value);
}
