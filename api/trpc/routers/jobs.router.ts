// api/trpc/routers/jobs.router.ts
//
// The POLL BACKSTOP (decisions §4.1). One procedure, and it is deliberately
// almost nothing.
//
// The happy path is the collector: an S3 event moves the result into Postgres
// and this endpoint just reads the row. The backstop matters in exactly two
// cases, and both are real:
//
//   1. The event is slow, dropped, or the notification configuration was
//      clobbered (`put-bucket-notification-configuration` REPLACES the whole
//      config — see the comment in template.yaml). The tab is open, the result
//      is in S3, and nobody has moved it.
//   2. `pnpm dev:api`, where there is no S3 event at all. Without this, local
//      development could never observe a job finish.
//
// It runs THE SAME `collectResult` the Lambda runs — not a simplified copy.
// §4.1: "S3 events are at-least-once — idempotency lives in the collector, in
// one place." A second implementation here would be a second idempotency, and
// the one exercised only in dev is the one that would be wrong in prod.
//
// A `query` rather than a `mutation`, even though it can write: the UI polls
// this on an interval, and react-query polls queries. That is only defensible
// because the write is idempotent by construction — the compare-and-set in
// api/collector/job-state.ts means a repeated poll, or two tabs polling at
// once, cannot double-write or regress the row.

import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../procedures";
import { db } from "../../db/client";
import { PollJobInput } from "../../../shared/validation/job-schemas";
import { collectResult } from "../../collector/collect";
import { loadJobById, type JobRow } from "../../collector/job-state";
import { malformedResultEnvelope } from "../../collector/relay-result";
import { enqueueRelayJob, getRelayJob, parseOutboxKey } from "../../lib/relay";

/**
 * What the client is allowed to see of a job row.
 *
 * `request` is omitted on purpose: it is the canonical job payload — system
 * prompt, field list, model choice — and the browser has no use for it. The
 * rest is the tenant's own data, `result` included: it is the model's answer to
 * a hop they paid for, and the analyse/verify screens read it directly.
 */
function toJobView(row: JobRow) {
  const { request: _request, ...view } = row;
  return view;
}

export const jobsRouter = router({
  poll: protectedProcedure.input(PollJobInput).query(async ({ ctx, input }) => {
    // Tenant-scoped read. `report_jobs.id` is a uuid the caller could only have
    // got from their own job, but "could only have" is not a predicate.
    const row = await loadJobById(db, ctx.tenantId, input.id);
    if (row === undefined) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Trabalho não encontrado." });
    }
    if (row.status !== "pending") {
      return toJobView(row);
    }

    // The row names the job key for the attempt in flight; the result key is
    // derived from its parts, never by string surgery on the stored key
    // (relay/src/keys.ts explains the class of bug that prevents).
    const key = parseOutboxKey(row.s3Key);
    if (key?.tenantId !== ctx.tenantId) {
      // A row whose key we cannot parse, or that names another tenant, is a
      // bug in whatever wrote it — but it is not the poller's to repair, and
      // reporting the row as-is keeps a broken job visible instead of throwing
      // on every poll.
      console.error("[jobs.poll] job row carries an unusable s3_key", { id: row.id });
      return toJobView(row);
    }

    const relayJob = await getRelayJob(ctx.tenantId, key.jobId);
    if (relayJob.status === "pending") {
      return toJobView(row);
    }

    // Same two lines as the Lambda, and for the same reason: a body nobody can
    // read must SETTLE the row. Left to throw, this endpoint would error on
    // every refetch of a job that can never move — the poll would report the
    // wedge instead of clearing it.
    const result =
      relayJob.status === "malformed" ? malformedResultEnvelope(relayJob.reason) : relayJob.result;

    await collectResult(
      { db, enqueue: enqueueRelayJob },
      { tenantId: ctx.tenantId, jobId: key.jobId, result },
    );

    // Re-read rather than reason about the outcome: the collector may have
    // settled the row, retried it under a new attempt, or lost the race to the
    // Lambda that ran a millisecond earlier. In every case the row is the
    // answer, and it is the only thing the UI polls.
    const after = await loadJobById(db, ctx.tenantId, input.id);
    return toJobView(after ?? row);
  }),
});
