// api/collector/collect.ts
//
// THE ONE CODE PATH. Every relay result reaches Postgres through this function,
// whether an S3 `ObjectCreated` event brought it (api/collector/handler.ts) or
// the client's poll asked for it (api/trpc/routers/jobs.router.ts).
//
// That is not a tidiness preference, it is decisions §4.1: "S3 events are
// at-least-once — idempotency lives in the collector, in one place." Two
// implementations of "move a result into the database" are two implementations
// of the idempotency, and the one that is exercised less is the one that is
// wrong. The poll backstop exists because the tab may be open when the event is
// slow and because `pnpm dev:api` has no S3 event wired up at all — neither is
// a reason for it to have its own opinion about what a result means.
//
// TENANCY, and why a machine may pick its own tenant. `tenantId` is not chosen
// by anything the collector can be told: it is parsed out of the OBJECT KEY,
// `results/{tenantId}/{jobId}.json`. That key is written only by the relay,
// which derives it from the parts of the JOB key it parsed
// (relay/src/keys.ts `resultKeyFor`), and the job key is written only by the
// API, which composed it from the caller's own verified `org_id`
// (api/lib/relay.ts `jobKeyFor`). No hop in that chain accepts a tenant from a
// payload, and §12.11 forbids adding another writer to `jobs/`. So the tenant a
// result claims IS the tenant that paid for it, and every query below carries
// it as a predicate — the collector never reads a row it was not sent to.
//
// WHAT THIS FILE WILL NOT DO. It does not validate the extraction against the
// frozen field list, does not compute the §12.12 numeric guardrails, and does
// not read a verifier's verdicts. Those need the template, the field list and
// the report context; a collector that grew them would be the pipeline, and
// would then need to be correct twice — once here and once wherever the retry
// orchestration actually lives. It moves bytes, decides the job's fate from the
// envelope, and stops.

import { jobKeyFor, nextAttemptJobId, parseJobId, type JobIdParts } from "../lib/relay";
import { insertExtractionIdempotent, resolveExtractionTarget } from "./extraction-store";
import {
  casAttempt,
  confirmEnqueue,
  ENQUEUE_PENDING_MARKER,
  isAwaitingEnqueue,
  loadJobByS3Key,
  MAX_ATTEMPTS,
  transition,
  type DbLike,
  type JobRow,
  type JobStatus,
} from "./job-state";
import {
  parseModelJson,
  parseRelayResult,
  type RelayFailure,
  type RelaySuccess,
} from "./relay-result";

/**
 * The two things the collector cannot do for itself.
 *
 * Injected rather than imported so both callers hand in the same pair, and so a
 * test can prove the retry actually enqueues without an S3 client in the way.
 * `enqueue` is `enqueueRelayJob` in both real callers.
 */
export interface CollectDeps {
  readonly db: DbLike;
  readonly enqueue: (
    tenantId: string,
    jobId: string,
    payload: Record<string, unknown>,
  ) => Promise<void>;
}

export interface CollectInput {
  /** From the RESULT KEY, never from the payload. */
  readonly tenantId: string;
  /** From the RESULT KEY. Carries the attempt as `-a{n}` (§12.1). */
  readonly jobId: string;
  /** The parsed result object, untrusted. */
  readonly result: unknown;
}

export type SkipReason =
  /** Not one of our jobIds — a foreign object under `results/`. */
  | "unparseable-job-id"
  /** No `report_jobs` row for this key yet, or ever. */
  | "no-job-row"
  /** The row has moved past this attempt (§12.1). */
  | "stale-attempt"
  /** Already collected — the duplicate delivery this design expects. */
  | "already-settled";

export type CollectOutcome =
  /** This call moved the row to a terminal status. */
  | { readonly action: "settled"; readonly status: JobStatus }
  /** This call bumped the row and enqueued attempt n+1 (§4.2). */
  | { readonly action: "retried"; readonly jobId: string; readonly attempt: number }
  /** Nothing to do; see `reason`. */
  | { readonly action: "skipped"; readonly reason: SkipReason }
  /** The other writer got there first. Not an error — the design's whole point. */
  | { readonly action: "lost-race" };

/** Working state for one result, assembled once by `collectResult`. */
interface JobContext {
  readonly tenantId: string;
  readonly jobId: string;
  readonly attempt: number;
  readonly row: JobRow;
  readonly raw: unknown;
}

/**
 * `revisar` means A HUMAN CAN FIX THIS HERE — it opens the field-by-field
 * repair screen §4.2 describes, and that screen only exists for an extraction.
 * A failed detect / analyse / verify has no per-field repair to offer, so it is
 * `failed`: honest about being over, and distinguishable in the UI from work
 * that is waiting on somebody.
 */
function terminalFailureStatus(kind: string): JobStatus {
  return kind === "extract" ? "revisar" : "failed";
}

/** jsonb comes back as `unknown`. A retry needs the payload it was enqueued
 * with, and a non-object is not one. */
function asPayload(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

async function settle(
  deps: CollectDeps,
  ctx: JobContext,
  status: JobStatus,
  error: string | null,
): Promise<CollectOutcome> {
  const moved = await transition(deps.db, {
    tenantId: ctx.tenantId,
    id: ctx.row.id,
    from: "pending",
    to: status,
    attempt: ctx.attempt,
    patch: { error, result: ctx.raw },
  });
  return moved ? { action: "settled", status } : { action: "lost-race" };
}

/**
 * §4.2's "auto-retry once", and the only place the collector writes to S3.
 *
 * ORDER IS LOAD-BEARING. The row is bumped FIRST, because that compare-and-set
 * is the mutual exclusion between the two writers: whoever wins it is the one
 * that gets to spend money on another provider call. Enqueueing first would let
 * a concurrent poll and collector both write a job file and both be billed,
 * with only one of them able to record that it did.
 *
 * If the enqueue then fails, `unwindFailedEnqueue` takes the row back down —
 * rolling the bump back if it can, escalating to terminal if it cannot. Without
 * that, the row sits at attempt n+1 pointing at a job object that does not
 * exist, and the redelivery that would have fixed it is rejected as a stale
 * attempt: a job wedged `pending` forever, which is the exact failure the
 * collector exists to prevent.
 */
async function enqueueRetry(
  deps: CollectDeps,
  ctx: JobContext,
  payload: Record<string, unknown>,
  reason: string,
): Promise<CollectOutcome> {
  const nextJobId = nextAttemptJobId(ctx.jobId);
  const nextAttempt = ctx.attempt + 1;
  const bumped = await casAttempt(deps.db, {
    tenantId: ctx.tenantId,
    id: ctx.row.id,
    fromAttempt: ctx.attempt,
    toAttempt: nextAttempt,
    // Marked until the job object is proven written. Between this statement and
    // the confirm below, the row is indistinguishable from a wedged one — the
    // marker is what makes it distinguishable again.
    s3Key: jobKeyFor(ctx.tenantId, nextJobId),
    error: `${ENQUEUE_PENDING_MARKER} ${reason}`,
  });
  if (!bumped) {
    return { action: "lost-race" };
  }
  try {
    await deps.enqueue(ctx.tenantId, nextJobId, payload);
  } catch (err) {
    await unwindFailedEnqueue(deps, ctx, nextAttempt);
    throw err;
  }
  await confirmEnqueue(deps.db, {
    tenantId: ctx.tenantId,
    id: ctx.row.id,
    attempt: nextAttempt,
    error: reason,
  });
  return { action: "retried", jobId: nextJobId, attempt: nextAttempt };
}

/**
 * The bump landed, the job object did not. The row now points at an attempt
 * nobody will ever run, and every later delivery of the previous attempt's
 * result is rejected as stale — `pending` forever, which is precisely what the
 * collector exists to prevent.
 *
 * Two ladders down, in order of how little damage they do:
 *
 *   1. ROLL BACK to attempt n. The row is exactly where it started, the same
 *      result is still in S3, and the next delivery (or poll) simply tries
 *      again. Best outcome, and the common one.
 *   2. ESCALATE to terminal at attempt n+1. Reached when the rollback itself
 *      cannot land — the row moved, or the database is unreachable. A `revisar`
 *      a human can act on beats a `pending` nobody will ever look at.
 *
 * If both fail the error is logged loudly and the original is rethrown: S3
 * redelivers, and the stale-path escalation in `collectResult` picks the row up
 * on the way back through. Every step is CAS-guarded, so a concurrent writer
 * that already settled the row simply wins and this does nothing.
 */
async function unwindFailedEnqueue(
  deps: CollectDeps,
  ctx: JobContext,
  nextAttempt: number,
): Promise<void> {
  const rolledBack = await casAttempt(deps.db, {
    tenantId: ctx.tenantId,
    id: ctx.row.id,
    fromAttempt: nextAttempt,
    toAttempt: ctx.attempt,
    s3Key: jobKeyFor(ctx.tenantId, ctx.jobId),
    error: null,
  }).catch(() => false);
  if (rolledBack) {
    return;
  }
  const escalated = await escalateWedged(deps, ctx, nextAttempt).catch(() => false);
  if (!escalated) {
    console.error("[collector] retry could not be enqueued, rolled back, or escalated", {
      id: ctx.row.id,
      attempt: nextAttempt,
    });
  }
}

/**
 * Terminal for a row stranded at an attempt that was never enqueued.
 *
 * CAS'd on (pending, nextAttempt), which is what makes it safe to call from
 * both the in-process unwind above and a later redelivery: whichever runs
 * second matches nothing and returns false.
 */
async function escalateWedged(
  deps: CollectDeps,
  ctx: JobContext,
  nextAttempt: number,
): Promise<boolean> {
  return transition(deps.db, {
    tenantId: ctx.tenantId,
    id: ctx.row.id,
    from: "pending",
    to: terminalFailureStatus(ctx.row.kind),
    attempt: nextAttempt,
    patch: { error: "não foi possível reenfileirar a tentativa; intervenção necessária" },
  });
}

/**
 * A failed hop: retry once, or stop.
 *
 * A `permanent` classification skips the retry entirely. relay/src/errors.ts is
 * explicit that this is what the classification is FOR — "`permanent` is a
 * refusal of that invitation" — and paying for a second call that will fail
 * identically is the thing §4.2's ceiling exists to bound.
 */
async function applyFailure(
  deps: CollectDeps,
  ctx: JobContext,
  failure: RelayFailure,
): Promise<CollectOutcome> {
  const stop = (why: string): Promise<CollectOutcome> =>
    settle(deps, ctx, terminalFailureStatus(ctx.row.kind), why);

  if (failure.type === "permanent") {
    return stop(`falha permanente: ${failure.message}`);
  }
  if (ctx.attempt >= MAX_ATTEMPTS) {
    return stop(`falha após ${String(ctx.attempt)} tentativas: ${failure.message}`);
  }
  const payload = asPayload(ctx.row.request);
  if (payload === null) {
    // Nothing to re-enqueue. The relay deleted the job object when it wrote the
    // result, so `report_jobs.request` is the only surviving copy — a row
    // without one cannot be retried by anybody, and pretending otherwise would
    // leave it pending.
    return stop(`falha sem payload para nova tentativa: ${failure.message}`);
  }
  return enqueueRetry(deps, ctx, payload, `tentativa ${String(ctx.attempt)}: ${failure.message}`);
}

/**
 * A successful EXTRACT hop: cache the artifact, then flip the job.
 *
 * The extraction is written BEFORE the status moves, and that order is the
 * idempotency. If the process dies between the two, the row is still `pending`,
 * the next delivery re-runs this path, and `ON CONFLICT DO NOTHING` makes the
 * second insert a no-op — so the work is never lost and never duplicated. The
 * reverse order would let a job read `done` with nothing cached behind it.
 */
async function applyExtractSuccess(
  deps: CollectDeps,
  ctx: JobContext,
  success: RelaySuccess,
): Promise<CollectOutcome> {
  const documentId = ctx.row.documentId;
  if (documentId === null) {
    return settle(deps, ctx, "revisar", "job de extração sem documento associado");
  }
  const parsed = parseModelJson(success.content);
  if (!parsed.ok) {
    // §4.2 — "most schema violations are transient". Same path as a relay
    // failure, same ceiling, same landing in `revisar`.
    return applyFailure(deps, ctx, { kind: "failure", type: "transient", message: parsed.message });
  }
  const target = await resolveExtractionTarget(deps.db, ctx.tenantId, documentId);
  if (target === null) {
    // A configuration problem (no detected type, or a soft-deleted template),
    // not a model problem: another paid extraction would land on the same
    // missing row. Straight to `revisar`.
    return settle(deps, ctx, "revisar", "documento sem template de extração ativo");
  }
  await insertExtractionIdempotent(deps.db, ctx.tenantId, target, parsed.data, {
    provider: success.provider,
    model: success.model,
  });
  return settle(deps, ctx, "done", null);
}

/** detect / analyse / verify: the result IS the artifact, and it is already on
 * its way into `report_jobs.result` via the transition's patch. The collector
 * does not read verdicts or slots — that is the orchestration's job (§12.13). */
async function applySuccess(
  deps: CollectDeps,
  ctx: JobContext,
  success: RelaySuccess,
): Promise<CollectOutcome> {
  if (ctx.row.kind === "extract") {
    return applyExtractSuccess(deps, ctx, success);
  }
  return settle(deps, ctx, "done", null);
}

/**
 * The second half of the wedge fix, and the reason `isAwaitingEnqueue` exists.
 *
 * A redelivery of attempt n's failed result, arriving at a row that is
 * `pending` on attempt n+1, has TWO possible meanings and they look identical
 * on the row:
 *
 *   a) the retry was enqueued and is running right now — HEALTHY, and S3 is
 *      entitled to redeliver the old result at any time; or
 *   b) the bump landed but the job object was never written — WEDGED.
 *
 * Terminating (a) would kill a live, already-paid retry, which is a worse bug
 * than the one this recovers from. The marker is what separates them: it is
 * written by the bump and cleared the instant the outbox write is confirmed, so
 * only (b) still carries it.
 *
 * Returns null for "not this case, carry on and skip" — including when the
 * compare-and-set finds nothing, which means another writer settled the row
 * first and the ordinary skip is the right answer after all.
 *
 * Residual window, stated plainly: if the enqueue succeeds but the confirming
 * update does not land, a healthy retry keeps the marker and a stale
 * redelivery would settle it early. That needs three failures to line up, and
 * it ends in a `revisar` a human can see with the result still in S3 — not in
 * a `pending` nobody will ever look at.
 */
async function recoverWedgedRetry(
  deps: CollectDeps,
  ctx: JobContext,
): Promise<CollectOutcome | null> {
  if (ctx.row.status !== "pending" || ctx.row.attempt !== ctx.attempt + 1) {
    return null;
  }
  if (!isAwaitingEnqueue(ctx.row)) {
    return null;
  }
  // Only a failure can have produced a bump, so anything else here is a
  // different situation than the one this understands.
  if (parseRelayResult(ctx.raw).kind !== "failure") {
    return null;
  }
  const escalated = await escalateWedged(deps, ctx, ctx.row.attempt);
  if (!escalated) {
    return null;
  }
  console.error("[collector] escalated a retry that was never enqueued", {
    id: ctx.row.id,
    attempt: ctx.row.attempt,
  });
  return { action: "settled", status: terminalFailureStatus(ctx.row.kind) };
}

/** The three guards that make a duplicate delivery free, in the order that
 * makes each one cheap: shape, then row, then attempt, then status. */
function guard(parts: JobIdParts | null, row: JobRow | undefined): SkipReason | null {
  if (parts === null) {
    return "unparseable-job-id";
  }
  if (row === undefined) {
    return "no-job-row";
  }
  if (row.attempt !== parts.attempt) {
    return "stale-attempt";
  }
  if (row.status !== "pending") {
    return "already-settled";
  }
  return null;
}

/**
 * Move one relay result into Postgres. Safe to call twice with the same input,
 * from either writer, concurrently.
 */
export async function collectResult(
  deps: CollectDeps,
  input: CollectInput,
): Promise<CollectOutcome> {
  const parts = parseJobId(input.jobId);
  const row =
    parts === null
      ? undefined
      : await loadJobByS3Key(deps.db, input.tenantId, jobKeyFor(input.tenantId, input.jobId));

  const skip = guard(parts, row);

  // Before the ordinary stale-skip: this MAY be the redelivery that finds a row
  // stranded by a retry that could not be enqueued. See recoverWedgedRetry —
  // it refuses to act on anything else.
  if (skip === "stale-attempt" && parts !== null && row !== undefined) {
    const recovered = await recoverWedgedRetry(deps, {
      tenantId: input.tenantId,
      jobId: input.jobId,
      attempt: parts.attempt,
      row,
      raw: input.result,
    });
    if (recovered !== null) {
      return recovered;
    }
  }

  if (skip !== null || parts === null || row === undefined) {
    // The row is missing on the happy-ish path too: the API must COMMIT the job
    // row before it PutObjects the job file, or a fast relay produces a result
    // for a row nobody can see yet. Warn rather than throw — throwing would
    // make S3 redeliver a notification that will never find its row, and the
    // poll backstop covers the ordering slip if there is one.
    console.warn("[collector] skipped", { key: input.jobId, reason: skip ?? "unparseable-job-id" });
    return { action: "skipped", reason: skip ?? "unparseable-job-id" };
  }

  const ctx: JobContext = {
    tenantId: input.tenantId,
    jobId: input.jobId,
    attempt: parts.attempt,
    row,
    raw: input.result,
  };
  const parsed = parseRelayResult(input.result);
  return parsed.kind === "success"
    ? applySuccess(deps, ctx, parsed)
    : applyFailure(deps, ctx, parsed);
}
