// api/collector/handler.ts
//
// The COLLECTOR Lambda (decisions §4.1) — the third function, and the reason it
// exists in one sentence: the relay cannot reach RDS (non-VPC) and the API
// cannot reach the internet (VPC, no NAT), so something VPC-bound has to move a
// finished result into Postgres.
//
// It needs NO internet. S3 is reached through the same free gateway endpoint
// the API already uses, and S3 → Lambda is a PUSH from the S3 service, not an
// outbound dial. No NAT, no new VPC endpoint, $0/month.
//
// WHY IT IS IN THE ROOT template.yaml and not relay/. This function is the
// API's twin, not the relay's: same VPC config, same DB_* environment, same
// drizzle schema and `api/db` code in the bundle. The relay's stack is
// deliberately VPC-less — that is the whole reason it is a separate stack — so
// putting a VPC-bound function in it would re-introduce the ENI churn that
// split buys us.
//
// WHY THE BODY IS FIVE LINES. Everything that decides anything lives in
// ./collect.ts, because the client's poll backstop runs the SAME function
// (§4.1: "idempotency lives in the collector, in one place"). What is left here
// is delivery semantics: decode the key, refuse what is not ours, read the
// object, and choose what a failure means for the S3 retry.

import type { S3Event } from "aws-lambda";
import { db } from "../db/client";
import { enqueueRelayJob, getRelayJob, parseOutboxKey } from "../lib/relay";
import { collectResult } from "./collect";
import { malformedResultEnvelope } from "./relay-result";

async function handleRecord(objectKey: string): Promise<void> {
  const key = parseOutboxKey(objectKey);
  // Not a result key — a foreign object, or a notification filter that has
  // drifted. Return rather than throw: a throw makes S3 redeliver an object
  // this function will never be able to process, forever.
  if (key?.prefix !== "results") {
    console.warn("[collector] ignoring an object that is not a result key", { objectKey });
    return;
  }

  // Read through api/lib/relay.ts rather than a second S3 client: `getRelayJob`
  // already derives the key from (tenantId, jobId) and names the bucket by the
  // one rule in api/lib/storage.ts. It is also the exact call the poll backstop
  // makes, so both writers read the same bytes the same way.
  const job = await getRelayJob(key.tenantId, key.jobId);
  if (job.status === "pending") {
    // The object fired an event and then was not there. Nothing to do and
    // nothing to retry — a delete or a lifecycle expiry, not a fault.
    console.warn("[collector] result object vanished before it could be read", { objectKey });
    return;
  }

  // A body we cannot read still SETTLES the job. Returning here (or letting a
  // parse throw) would leave the row `pending` forever with the unreadable
  // object still in the bucket re-failing every redelivery.
  const result = job.status === "malformed" ? malformedResultEnvelope(job.reason) : job.result;

  const outcome = await collectResult(
    { db, enqueue: enqueueRelayJob },
    { tenantId: key.tenantId, jobId: key.jobId, result },
  );
  console.warn("[collector] processed", { objectKey, outcome });
}

/**
 * S3-triggered on the `results/` prefix.
 *
 * A throw here IS the retry: `EventInvokeConfig` in template.yaml gives the
 * invocation two more chances, which is what covers a transient RDS blip. That
 * is safe precisely because `collectResult` is idempotent — a redelivery after
 * a partial write finds the row already settled and skips it.
 */
export const handler = async (event: S3Event): Promise<void> => {
  for (const record of event.Records) {
    // S3 event keys are URL-encoded, and `+` means a space rather than a plus.
    await handleRecord(decodeURIComponent(record.s3.object.key.replace(/\+/gu, " ")));
  }
};
