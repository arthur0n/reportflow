// api/collector/poll-job.ts
//
// THE POLL BACKSTOP (decisions §4.1), extracted so that every screen which
// polls a job runs the identical one.
//
// The happy path is the collector Lambda: an S3 event moves the result into
// Postgres and a poll is a plain row read. The backstop matters in exactly
// two cases, and both are real:
//
//   1. The event is slow, dropped, or the notification configuration was
//      clobbered (`put-bucket-notification-configuration` REPLACES the whole
//      config — see the comment in template.yaml). The tab is open, the
//      result is in S3, and nobody has moved it.
//   2. `pnpm dev:api`, where there is no S3 event at all. Without this, local
//      development could never observe a job finish.
//
// It runs THE SAME `collectResult` the Lambda runs — not a simplified copy.
// §4.1: "S3 events are at-least-once — idempotency lives in the collector, in
// one place." A second implementation would be a second idempotency, and the
// one exercised only in dev is the one that would be wrong in prod. The same
// argument is why this function exists at all rather than being inlined in
// jobs.router.ts and then copied into calibration.router.ts.

import { db } from "../db/client";
import { collectResult } from "./collect";
import { loadJobById, type JobRow } from "./job-state";
import { malformedResultEnvelope } from "./relay-result";
import { enqueueRelayJob, getRelayJob, parseOutboxKey } from "../lib/relay";

/**
 * Reads `report_jobs.id` under `tenantId`, and — only while the row is still
 * `pending` — checks S3 for a result nobody has collected yet.
 *
 * Returns `undefined` when the row is not this tenant's. Callers turn that
 * into their own NOT_FOUND: the message a user sees belongs to the screen
 * that asked, not to the backstop.
 *
 * Safe to call on an interval and from two tabs at once: the write it can
 * trigger is idempotent by construction (the compare-and-set in
 * api/collector/job-state.ts), which is what makes a tRPC `query` — the thing
 * react-query knows how to poll — defensible for a function that can write.
 */
export async function pollJobRow(tenantId: string, id: string): Promise<JobRow | undefined> {
  // Tenant-scoped read. `report_jobs.id` is a uuid the caller could only have
  // got from their own job, but "could only have" is not a predicate.
  const row = await loadJobById(db, tenantId, id);
  if (row === undefined) {
    return undefined;
  }
  if (row.status !== "pending") {
    return row;
  }

  // The row names the job key for the attempt in flight; the result key is
  // derived from its parts, never by string surgery on the stored key
  // (relay/src/keys.ts explains the class of bug that prevents).
  const key = parseOutboxKey(row.s3Key);
  if (key?.tenantId !== tenantId) {
    // A row whose key we cannot parse, or that names another tenant, is a bug
    // in whatever wrote it — but it is not the poller's to repair, and
    // reporting the row as-is keeps a broken job visible instead of throwing
    // on every poll.
    console.error("[poll-job] job row carries an unusable s3_key", { id: row.id });
    return row;
  }

  const relayJob = await getRelayJob(tenantId, key.jobId);
  if (relayJob.status === "pending") {
    return row;
  }

  // Same two lines as the Lambda, and for the same reason: a body nobody can
  // read must SETTLE the row. Left to throw, the poll would error on every
  // refetch of a job that can never move — reporting the wedge instead of
  // clearing it.
  const result =
    relayJob.status === "malformed" ? malformedResultEnvelope(relayJob.reason) : relayJob.result;

  await collectResult({ db, enqueue: enqueueRelayJob }, { tenantId, jobId: key.jobId, result });

  // Re-read rather than reason about the outcome: the collector may have
  // settled the row, retried it under a new attempt, or lost the race to the
  // Lambda that ran a millisecond earlier. In every case the row is the
  // answer, and it is the only thing the UI polls.
  const after = await loadJobById(db, tenantId, id);
  return after ?? row;
}
