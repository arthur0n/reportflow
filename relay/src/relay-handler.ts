// relay/src/relay-handler.ts
//
// ReportFlow's outbound relay, following docs/relay_lambda.md.
//
// The API Lambda is VPC-bound for RDS and therefore has no internet egress (no
// NAT — deliberate, ~$32/mo). AI providers need the internet. So the API
// PutObjects a job to `jobs/{tenantId}/{jobId}.json` in the docs bucket through
// the FREE S3 gateway endpoint, an ObjectCreated event triggers this handler,
// it writes `results/{tenantId}/{jobId}.json`, deletes the job, and the
// collector (decisions §4.1) moves the result into Postgres.
//
// CHANNEL-ROUTED, not one Lambda per task: a new outbound capability is an
// entry in CHANNELS plus a secret under the same SSM prefix, with no IAM change
// and no new function. `ai` is ReportFlow's first — and it carries the provider
// adapter registry, so "add a provider" is one level deeper and just as cheap
// (§6).
//
// TRUST BOUNDARY (§12.11). No Function URL and no API Gateway event, so this is
// unreachable from a browser. It processes ONLY keys under `jobs/`, written
// solely by the API, which has already validated ownership — so there is no
// payload-level re-authorization here, and no other writer may be added to that
// prefix. What the parsing in job.ts does buy is the tenant BINDING (the relay
// holds s3:GetObject across the bucket) and a bound on what a bug can cost.
//
// RETRIES ARE NOT LAMBDA RETRIES (§12.1). A failure is CLASSIFIED and written
// as a result; the collector decides whether to enqueue attempt n+1 under a new
// jobId. So a transient provider failure produces `{ error: { type:
// "transient" } }` rather than a thrown invoke — the job's fate is a pipeline
// decision made where the pipeline state lives, which is not here. Only a
// failure that leaves NO result to write is rethrown, because then there is
// nothing for anyone to read and the invoke retry is the last line of defence.

import type { S3Event } from "aws-lambda";
import { aiChannel } from "./channels/ai";
import { describeError, errorType } from "./errors";
import { parseJob, type AiJob } from "./job";
import { claimKeyFor, parseJobKey, resultKeyFor } from "./keys";
import type { AiResult } from "./providers/types";
import { deleteQuietly, exists, putIfAbsent, readText } from "./s3";

/** What lands in `results/{tenantId}/{jobId}.json` (§6). A success is the
 * canonical adapter result verbatim — the relay adds nothing, because anything
 * it added would be a fact the API would then have to trust it about. */
export type RelayResult =
  AiResult | { error: { type: "permanent" | "transient"; message: string } };

/**
 * The channel registry (relay_lambda.md, "Adding a channel").
 *
 * `email`/`sms` would be siblings of `ai` here, each a function of the parsed
 * job. ReportFlow has no user-facing outbound messages today, so `ai` is alone.
 */
const CHANNELS = { ai: aiChannel } as const;

async function dispatch(job: AiJob): Promise<AiResult> {
  return CHANNELS[job.channel](job);
}

/** Reads and runs one job. Split from the handler so the handler is only about
 * delivery semantics — duplicates, result writes, cleanup — and this is only
 * about the job. */
async function runJob(bucket: string, jobKey: string, tenantId: string): Promise<AiResult> {
  const raw: unknown = JSON.parse(await readText(bucket, jobKey));
  return dispatch(parseJob(raw, tenantId));
}

async function handleRecord(bucket: string, jobKey: string): Promise<void> {
  // A key we cannot parse gives us no result key to write an error to, so it
  // fails the invoke once and shows up in the logs. Deriving a result key from
  // an unparsed string is exactly the bug parseJobKey exists to prevent.
  const key = parseJobKey(jobKey);
  const resultKey = resultKeyFor(key);
  const claimKey = claimKeyFor(key);

  // The cheap path for the common duplicate, which is a redelivery AFTER the
  // work finished. It is a read, so it cannot decide a race on its own — the
  // claim below does that — but it saves a provider call in the case that
  // actually happens.
  if (await exists(bucket, resultKey)) {
    console.warn("[relay] duplicate delivery, result already written", { jobKey });
    await deleteQuietly(bucket, jobKey);
    return;
  }

  // THE CLAIM, and it is taken BEFORE the provider is called rather than after.
  // The check above is check-then-act: two concurrent deliveries can both see no
  // result, both call the provider, and both are billed — and at ~$0.28 a report
  // that is the expensive half of the job, not a rounding error. A conditional
  // PutObject is atomic, so exactly one writer wins.
  //
  // The loser stands down QUIETLY, which is where this departs from smartstocke
  // (its loser retries). It can, because ReportFlow's durability lives in
  // Postgres rather than in the client's poll: if the winner dies without
  // writing a result, `report_jobs` is still `pending` and the collector's
  // backstop enqueues attempt n+1 under a new jobId (§4.1, §12.1) — which is a
  // new claim key too, so a leaked claim cannot wedge the work. Retrying here
  // would duplicate that recovery in the one place that cannot see the row.
  if (
    !(await putIfAbsent(bucket, claimKey, JSON.stringify({ claimedAt: new Date().toISOString() })))
  ) {
    console.warn("[relay] claim held by another delivery, standing down", { jobKey });
    return;
  }

  let result: RelayResult;
  try {
    result = await runJob(bucket, jobKey, key.tenantId);
  } catch (err) {
    const type = errorType(err);
    console.error(`[relay:ai] job failed (${type})`, { jobKey, err });
    result = { error: { type, message: describeError(err) } };
  }

  try {
    // Still conditional, even holding the claim: the claim orders the PROVIDER
    // call, and this orders the ANSWER. A delivery that claimed after a leaked
    // claim expired must not overwrite a result the original winner wrote late.
    const written = await putIfAbsent(bucket, resultKey, JSON.stringify(result));
    if (!written) {
      console.warn("[relay] result already written by a concurrent delivery", { resultKey });
    }
  } catch (err) {
    // Nothing was written, so nobody can read an answer. Release the claim so a
    // retry can take it, then let the invoke fail.
    await deleteQuietly(bucket, claimKey);
    throw err;
  }
  // The claim is NOT released on success: the result now short-circuits every
  // later delivery at the check above, and the bucket's lifecycle rule collects
  // the claim object alongside the job and the result.
  await deleteQuietly(bucket, jobKey);
}

/**
 * S3-triggered on the `jobs/` prefix (§12.11).
 *
 * Records are processed in order and a throw abandons the rest of the batch.
 * That is correct here: S3 delivers one record per event in practice, and a
 * throw at this level means the failure was one that left nothing readable
 * anywhere — the case where retrying the whole delivery is the right answer.
 */
export const handler = async (event: S3Event): Promise<void> => {
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    // S3 event keys are URL-encoded, and `+` means a space rather than a plus.
    const jobKey = decodeURIComponent(record.s3.object.key.replace(/\+/gu, " "));
    await handleRecord(bucket, jobKey);
  }
};
