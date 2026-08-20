// api/lib/relay.ts
//
// The API's half of the relay contract: write a job, poll for a result.
// Ported from smartstocke/api/lib/relay.ts so the two projects stay one shape;
// the deltas are named where they occur.
//
// The API can reach S3 through the FREE gateway endpoint but cannot reach the
// internet, and the relay can reach the internet but not RDS. The outbox is the
// only thing they share, which is why this is a file drop rather than a call.
//
// DELTA FROM SMARTSTOCKE 1 — one bucket. smartstocke has a dedicated
// `smartstocke-relay-outbox-prod`; ReportFlow puts `jobs/` and `results/`
// inside the documents bucket it already has (`reportflow-docs-prod`). The
// relay needs to read the tenants' PDFs anyway, so a second bucket would buy a
// second grant and nothing else. The prefixes still carry the direction split
// that matters (the API writes jobs/ and reads results/; the relay does the
// reverse), which is enforced in relay/template.yaml.
//
// DELTA FROM SMARTSTOCKE 2 — jobIds carry an attempt number (§12.1). See
// mintJobId.
//
// DELTA FROM SMARTSTOCKE 3 — the client is not the collector. smartstocke has
// the browser poll and persist; here a VPC-bound collector Lambda moves results
// into Postgres on a `results/` trigger (§4.1), because "latency is not the
// issue, losing time is". `getRelayJob` therefore serves the POLL BACKSTOP
// (§4.1) and local `pnpm dev:api`, where no S3 event is wired up — not the
// happy path.

import { randomUUID } from "node:crypto";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { docsBucket } from "./storage";

const REGION = process.env["AWS_REGION"] ?? "sa-east-1";

const s3 = new S3Client({ region: REGION });

/** Matches the relay's SEGMENT pattern (relay/src/keys.ts): the jobId becomes a
 * path segment, and the relay refuses one containing `/` or `.`. */
const JOB_ID = /^([0-9a-f-]{36})-a([1-9]\d{0,2})$/u;

export interface JobIdParts {
  /** Stable across attempts. Identifies the WORK, not the try. */
  readonly base: string;
  /** 1 for the first attempt. */
  readonly attempt: number;
}

/**
 * Job ids are opaque, unguessable, and carry the attempt number (§12.1).
 *
 * The uuid half is the same reasoning as smartstocke's: the id appears in an
 * object key alongside the tenantId and the relay parses that key with a
 * segment pattern excluding `/` and `.`, so a uuid is both the safe shape and
 * the collision-free one.
 *
 * The `-a{n}` half is the amendment. Retries are new JOBS, not re-invocations:
 * the relay classifies a failure and writes it as a result, and the collector
 * decides whether to enqueue another attempt. Two attempts at the same work
 * therefore have two result objects in flight at once, and §12.1 requires the
 * collector to "reject writes for a stale attempt" — which it can only do if
 * the attempt is legible from the key. Putting it in the id rather than in the
 * payload means the collector can compare attempts without opening either file.
 */
export function mintJobId(attempt = 1): string {
  return `${randomUUID()}-a${String(attempt)}`;
}

/** Splits a jobId, or returns null if it is not one. Returns null rather than
 * throwing because the caller reading a jobId is usually deciding whether to
 * trust it, and a throw would make "not ours" indistinguishable from a bug. */
export function parseJobId(jobId: string): JobIdParts | null {
  const m = JOB_ID.exec(jobId);
  if (m?.[1] === undefined || m[2] === undefined) {
    return null;
  }
  return { base: m[1], attempt: Number.parseInt(m[2], 10) };
}

/**
 * The id for the NEXT attempt at the same work — same base, attempt + 1.
 *
 * Keeping the base is what lets the collector recognise two results as being
 * about one job. Minting a fresh uuid instead would make the retry a different
 * job that happens to do the same thing, and the stale-attempt check in §12.1
 * would have nothing to compare.
 */
export function nextAttemptJobId(jobId: string): string {
  const parts = parseJobId(jobId);
  if (parts === null) {
    throw new Error(`not a jobId: ${jobId}`);
  }
  return `${parts.base}-a${String(parts.attempt + 1)}`;
}

/** `jobs/{tenantId}/{jobId}.json` — the only prefix the relay consumes
 * (§12.11), and the only one the API writes. */
export function jobKeyFor(tenantId: string, jobId: string): string {
  return `jobs/${tenantId}/${jobId}.json`;
}

/** `results/{tenantId}/{jobId}.json` — written by the relay, never by the API. */
export function resultKeyFor(tenantId: string, jobId: string): string {
  return `results/${tenantId}/${jobId}.json`;
}

/** The relay's own segment rule (relay/src/keys.ts), restated here because the
 * two bundles cannot import each other. api/lib/relay.test.ts pins that they
 * still agree. */
const SEGMENT = /^[A-Za-z0-9_-]{1,128}$/u;

export type OutboxPrefix = "jobs" | "results";

export interface OutboxKeyParts {
  readonly prefix: OutboxPrefix;
  readonly tenantId: string;
  readonly jobId: string;
}

/**
 * The INVERSE of `jobKeyFor` / `resultKeyFor`, and the collector's entry point:
 * an S3 `ObjectCreated` event hands it a key and nothing else.
 *
 * Parses the WHOLE shape and refuses anything that is not exactly three
 * segments under a known prefix — the same rule, and the same reason, as
 * `parseJobKey` in relay/src/keys.ts: a `tenantId` taken from a key that was
 * never proven to be a key is a path expression, and every tenant check
 * downstream of it is then checking a value the caller chose.
 *
 * Returns null rather than throwing. Both callers are deciding whether a key is
 * theirs — the collector sees every notification the bucket sends it, and the
 * poll backstop reads a column — so "not ours" must be answerable without
 * making it look like a fault.
 */
export function parseOutboxKey(key: string): OutboxKeyParts | null {
  const parts = key.split("/");
  if (parts.length !== 3) {
    return null;
  }
  const [prefix, tenantId = "", file = ""] = parts;
  if (prefix !== "jobs" && prefix !== "results") {
    return null;
  }
  if (!SEGMENT.test(tenantId) || !file.endsWith(".json")) {
    return null;
  }
  const jobId = file.slice(0, -".json".length);
  if (!SEGMENT.test(jobId)) {
    return null;
  }
  return { prefix, tenantId, jobId };
}

/**
 * Drops the job in the outbox. Fire and forget: the S3 PutObject succeeding is
 * the whole handoff, and nothing here waits for the relay.
 *
 * `payload` is `Record<string, unknown>` and not a typed job on purpose. The
 * canonical payload is defined by decisions §6 and re-validated by the relay
 * (relay/src/job.ts); a type here would be a THIRD statement of the same shape,
 * in the package that cannot import the relay's copy, which is how the two
 * drift. Callers build the object; the relay is the authority on whether it is
 * one.
 */
export async function enqueueRelayJob(
  tenantId: string,
  jobId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: docsBucket(),
      Key: jobKeyFor(tenantId, jobId),
      Body: JSON.stringify(payload),
      ContentType: "application/json",
    }),
  );
}

/**
 * The largest result body this API will read. 10 MiB is two orders of magnitude
 * above a real result — §6.2 budgets a few thousand output tokens — so anything
 * over it is a bug or a foreign object, and reading it would cost the Lambda's
 * memory to learn nothing.
 */
export const MAX_RESULT_BYTES = 10 * 1024 * 1024;

/**
 * Three outcomes, not two.
 *
 * `malformed` exists because the alternative was a THROW, and a throw here does
 * not settle anything: neither ingress path reaches a compare-and-set, so the
 * row stays `pending` forever while the poll errors on every refetch. A body we
 * cannot read is a FACT about the job, and the state machine has a place to put
 * facts about a job. It is the caller's business what it means (see
 * api/collector/collect.ts) — this function's business is to answer without
 * exploding.
 */
export type RelayJobStatus =
  | { status: "pending" }
  | { status: "ready"; result: unknown }
  | { status: "malformed"; reason: string };

/** Bounded so a stream error or a parser's echo of the input cannot become the
 * `report_jobs.error` column. Same rule the relay applies to its own errors. */
function describe(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

/**
 * Reads the result, or reports that it is not there yet.
 *
 * Returns the parsed JSON as `unknown` ON PURPOSE. Whatever this reads is
 * untrusted input and has to be validated by the caller against a schema; a
 * typed return here would be a claim this function is in no position to make.
 * (§12.4 — a model's JSON is untrusted no matter who called the model.)
 *
 * The result is NOT deleted. The collector may run after a poll, a poll may
 * repeat after a dropped response, and a delete would turn the second read into
 * a permanent "pending". The bucket's lifecycle rule collects them instead.
 */
export async function getRelayJob(tenantId: string, jobId: string): Promise<RelayJobStatus> {
  let out;
  try {
    // Only the GET is inside this catch. Wrapping the parse in it too is what
    // made a malformed body indistinguishable from a missing one — and neither
    // "pending" nor a throw settles the row.
    out = await s3.send(
      new GetObjectCommand({ Bucket: docsBucket(), Key: resultKeyFor(tenantId, jobId) }),
    );
  } catch (err) {
    const name = typeof err === "object" && err !== null ? (err as { name?: unknown }).name : "";
    if (name === "NoSuchKey" || name === "NotFound") {
      return { status: "pending" };
    }
    throw err;
  }

  if (out.Body === undefined) {
    return { status: "pending" };
  }
  // Checked BEFORE the body is streamed: the point of a cap is not to reject a
  // large string after paying to build it, and this Lambda's memory is the
  // budget an oversized object would eat.
  if ((out.ContentLength ?? 0) > MAX_RESULT_BYTES) {
    return { status: "malformed", reason: `resultado excede ${String(MAX_RESULT_BYTES)} bytes` };
  }

  let text: string;
  try {
    text = await out.Body.transformToString();
  } catch (err) {
    return { status: "malformed", reason: `falha ao ler o corpo: ${describe(err)}` };
  }
  // The backstop for a missing or lying ContentLength.
  if (text.length > MAX_RESULT_BYTES) {
    return { status: "malformed", reason: `resultado excede ${String(MAX_RESULT_BYTES)} bytes` };
  }

  try {
    return { status: "ready", result: JSON.parse(text) as unknown };
  } catch (err) {
    return { status: "malformed", reason: `corpo não é JSON: ${describe(err)}` };
  }
}
