// api/trpc/routers/jobs.router.ts
//
// The generic job poll (decisions §4.1). One procedure, and it is deliberately
// almost nothing: the backstop itself lives in api/collector/poll-job.ts so
// that this router and calibration.router.ts poll through the identical code
// path, for the same reason the poll and the collector Lambda share
// `collectResult` — a second implementation is a second idempotency, and the
// one exercised less is the one that is wrong.
//
// A `query` rather than a `mutation`, even though `pollJobRow` can write: the
// UI polls this on an interval, and react-query polls queries. That is only
// defensible because the write is idempotent by construction — see the
// compare-and-set in api/collector/job-state.ts.

import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../procedures";
import { PollJobInput } from "../../../shared/validation/job-schemas";
import { pollJobRow } from "../../collector/poll-job";
import { type JobRow } from "../../collector/job-state";

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
    const row = await pollJobRow(ctx.tenantId, input.id);
    if (row === undefined) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Trabalho não encontrado." });
    }
    return toJobView(row);
  }),
});
