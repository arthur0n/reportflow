// api/collector/job-state.ts
//
// The `report_jobs` state machine (decisions §12.1). Every write to a job row
// goes through this file; nothing else may set `status`.
//
// WHY A STATE MACHINE AND NOT AN UPDATE. There are two writers on the same row
// — the collector (S3 `ObjectCreated` on `results/`, which is at-least-once)
// and the client's poll backstop (§4.1) — and they can run at the same instant
// on the same result. "Read the row, decide, write it back" is check-then-act:
// both read `pending`, both decide, and the second write silently undoes or
// duplicates the first. So every transition here is COMPARE-AND-SET: the
// expected state is part of the WHERE clause, Postgres decides the race, and
// the loser learns it lost from the row count rather than from a second read
// that has already gone stale.
//
// THREE RULES, and they are the whole file:
//
//   1. FORWARD ONLY. `pending → revisar | done | failed`, never the reverse and
//      never terminal → terminal. A regression is not a race we can lose
//      gracefully: it would re-open a job a human has already repaired, or
//      throw away the `revisar` flags they were about to act on.
//   2. ONE ATTEMPT AT A TIME. `attempt` is in the WHERE clause of every
//      transition, so a result belonging to a superseded attempt cannot land on
//      a row that has already moved on (§12.1's stale-attempt rejection). The
//      caller checks the attempt too, before it does any work — but only this
//      check is atomic with the write.
//   3. THE TENANT IS IN THE WHERE CLAUSE. The collector runs outside a user
//      request; `tenantId` comes from the S3 key. See api/collector/collect.ts
//      for why that is a safe provenance — here it is simply never optional.
//
// A regression is a THROW, not a `false`. `false` means "someone else got there
// first", which is an ordinary outcome the callers handle; asking to move
// `done → pending` is a bug in the caller, and returning "no rows matched"
// would let it read as the ordinary outcome and be swallowed.

import { and, desc, eq } from "drizzle-orm";
import { reportJobs } from "../../drizzle/schema";
import type { db } from "../db/client";

/** A drizzle transaction handle (the arg passed into db.transaction's callback). */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The pool or a tx — same shape as api/services/documents-crud.ts, so a
 * collector write can be composed into a transaction later without a rewrite. */
export type DbLike = typeof db | Tx;

export type JobRow = typeof reportJobs.$inferSelect;

/** Mirrors `report_jobs_status_check` in drizzle/tables/pipeline.ts. Two
 * statements of the same list, so job-state.test.ts pins them together. */
export const JOB_STATUSES = ["pending", "revisar", "done", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Mirrors `report_jobs_kind_check`. */
export const JOB_KINDS = ["detect", "extract", "analyse", "verify"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/**
 * §4.2 — "auto-retry once". Attempts are 1-based because the jobId's `-a{n}`
 * suffix is (api/lib/relay.ts `mintJobId` starts at 1), so the ceiling is 2:
 * the original try plus the one retry the design allows. Beyond it the answer
 * is a human, not another paid call.
 */
export const MAX_ATTEMPTS = 2;

/** `pending` is the only state with anywhere to go. */
export function isForward(from: JobStatus, to: JobStatus): boolean {
  return from === "pending" && to !== "pending";
}

/** Whether a status is settled. Nothing may move a settled job (§12.1). */
export function isTerminal(status: JobStatus): boolean {
  return status !== "pending";
}

/** Columns a transition may carry alongside the status flip. Deliberately
 * small: `status`, `attempt` and `s3_key` are the machine's own state, and
 * anything else a caller wants to write belongs to the caller's own table. */
export interface JobPatch {
  /** pt-BR-free operator text; the UI renders its own message from `status`. */
  readonly error?: string | null;
  /** The relay result verbatim (§6). */
  readonly result?: unknown;
}

export interface TransitionArgs {
  readonly tenantId: string;
  /** `report_jobs.id` — the row, not the jobId. */
  readonly id: string;
  readonly from: JobStatus;
  readonly to: JobStatus;
  /** The attempt the caller believes is in flight. Part of the WHERE clause. */
  readonly attempt: number;
  readonly patch?: JobPatch;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Compare-and-set on (id, tenant, status, attempt). True iff THIS caller moved
 * the row.
 *
 * `created_by` / `last_upd_by` are left NULL rather than stamped with a
 * sentinel: no user did this. `withSystemFields` wants a `userId` and there
 * isn't one — the collector is a machine acting on an S3 event, and inventing
 * an id for it would put a value in an audit column that no audit could ever
 * resolve.
 */
export async function transition(dbHandle: DbLike, args: TransitionArgs): Promise<boolean> {
  if (!isForward(args.from, args.to)) {
    throw new Error(
      `report_jobs status may only move forward from pending (§12.1): refused ${args.from} → ${args.to}`,
    );
  }
  const patch = args.patch ?? {};
  const rows = await dbHandle
    .update(reportJobs)
    .set({
      status: args.to,
      ...(patch.error === undefined ? {} : { error: patch.error }),
      ...(patch.result === undefined ? {} : { result: patch.result }),
      lastUpdAt: nowIso(),
    })
    .where(
      and(
        eq(reportJobs.id, args.id),
        eq(reportJobs.tenantId, args.tenantId),
        eq(reportJobs.status, args.from),
        eq(reportJobs.attempt, args.attempt),
      ),
    )
    .returning({ id: reportJobs.id });
  return rows.length === 1;
}

export interface AttemptCasArgs {
  readonly tenantId: string;
  readonly id: string;
  readonly fromAttempt: number;
  readonly toAttempt: number;
  /** The new `jobs/{tenantId}/{jobId}.json` key for `toAttempt`. */
  readonly s3Key: string;
  readonly error?: string | null;
}

/**
 * Moves a row to another ATTEMPT while leaving it `pending` — the retry bump of
 * §4.2, and its rollback.
 *
 * Separate from `transition` because it is the one write that does not change
 * status, and folding it in would mean relaxing the forward-only rule for
 * exactly the case that most looks like a regression. Here the guard is the
 * attempt itself: the row must still be `pending` AND still be on
 * `fromAttempt`, so two collectors racing the same failed result produce one
 * retry, not two paid ones.
 *
 * The rollback is this same call with the attempts swapped (see collect.ts):
 * bumping the row and then failing to write the job object would otherwise
 * leave a row pointing at a job nobody will ever run.
 */
export async function casAttempt(dbHandle: DbLike, args: AttemptCasArgs): Promise<boolean> {
  const rows = await dbHandle
    .update(reportJobs)
    .set({
      attempt: args.toAttempt,
      s3Key: args.s3Key,
      ...(args.error === undefined ? {} : { error: args.error }),
      lastUpdAt: nowIso(),
    })
    .where(
      and(
        eq(reportJobs.id, args.id),
        eq(reportJobs.tenantId, args.tenantId),
        eq(reportJobs.status, "pending"),
        eq(reportJobs.attempt, args.fromAttempt),
      ),
    )
    .returning({ id: reportJobs.id });
  return rows.length === 1;
}

/**
 * Written into `report_jobs.error` by the retry bump and cleared the moment the
 * job object is actually in the outbox.
 *
 * It exists to tell two states apart that are otherwise IDENTICAL on the row —
 * "bumped to attempt n+1, job file written" and "bumped to attempt n+1, job
 * file never written". Both are `pending` at attempt n+1. Only the second is
 * wedged, and terminating the first would kill a live retry every time S3
 * redelivers attempt n's failure result, which it is entitled to do.
 *
 * A marker in `error` rather than a new column: the column already means "why
 * this row is where it is", and that is exactly what this says.
 */
export const ENQUEUE_PENDING_MARKER = "[reenfileirando]";

/** Whether a row is mid-retry with its job object not yet confirmed written. */
export function isAwaitingEnqueue(row: JobRow): boolean {
  return row.error?.startsWith(ENQUEUE_PENDING_MARKER) === true;
}

/**
 * Clears the marker once the job object is in the outbox. CAS-guarded on the
 * same (pending, attempt) pair as the bump, so it cannot touch a row another
 * writer has already moved on from.
 */
export async function confirmEnqueue(
  dbHandle: DbLike,
  args: { tenantId: string; id: string; attempt: number; error: string },
): Promise<boolean> {
  const rows = await dbHandle
    .update(reportJobs)
    .set({ error: args.error, lastUpdAt: nowIso() })
    .where(
      and(
        eq(reportJobs.id, args.id),
        eq(reportJobs.tenantId, args.tenantId),
        eq(reportJobs.status, "pending"),
        eq(reportJobs.attempt, args.attempt),
      ),
    )
    .returning({ id: reportJobs.id });
  return rows.length === 1;
}

/** The job row for an outbox key. Tenant-scoped even though `s3_key` is UNIQUE:
 * the uniqueness makes the tenant predicate redundant, not unnecessary — it is
 * what stops a malformed key from reaching another tenant's row at all. */
export async function loadJobByS3Key(
  dbHandle: DbLike,
  tenantId: string,
  s3Key: string,
): Promise<JobRow | undefined> {
  const rows = await dbHandle
    .select()
    .from(reportJobs)
    .where(and(eq(reportJobs.s3Key, s3Key), eq(reportJobs.tenantId, tenantId)))
    .limit(1);
  return rows[0];
}

/** The job row the UI is polling. Same tenant predicate, different key. */
export async function loadJobById(
  dbHandle: DbLike,
  tenantId: string,
  id: string,
): Promise<JobRow | undefined> {
  const rows = await dbHandle
    .select()
    .from(reportJobs)
    .where(and(eq(reportJobs.id, id), eq(reportJobs.tenantId, tenantId)))
    .limit(1);
  return rows[0];
}

/**
 * THE ONE TRANSITION A HUMAN MAKES: `revisar → done` (§4.2).
 *
 * Deliberately NOT routed through `transition`, and `isForward` is deliberately
 * NOT loosened to admit it. Those guard the MACHINE's writes, where the only
 * legal move is out of `pending` and where "the row is already terminal" always
 * means "another writer got there first, stop". This is a different fact
 * altogether: `revisar` is the one terminal status that is not the END of the
 * work, it is a request for a person, and §4.2 says the person's answer is
 * "persisted and never re-run". Folding it into `transition` would mean
 * relaxing the forward-only rule for every collector call site in order to
 * serve one router call site.
 *
 * It is still a compare-and-set, on `status = 'revisar'` and on the KIND: a
 * job that has already been resolved (a double-clicked [Salvar correção], two
 * open tabs) matches nothing and returns `false`, which the caller reports as
 * "nothing to resolve" rather than as an error. Status still only moves
 * forward — `done` is terminal and nothing here can move it back.
 *
 * `last_upd_by` IS stamped, unlike every other write in this file: a person
 * did this one, and they are exactly who an audit would want to find.
 */
export async function resolveRevisarJob(
  dbHandle: DbLike,
  args: {
    readonly tenantId: string;
    readonly userId: string;
    readonly documentId: string;
    readonly kind: JobKind;
  },
): Promise<number> {
  const rows = await dbHandle
    .update(reportJobs)
    .set({ status: "done", error: null, lastUpdAt: nowIso(), lastUpdBy: args.userId })
    .where(
      and(
        eq(reportJobs.tenantId, args.tenantId),
        eq(reportJobs.documentId, args.documentId),
        eq(reportJobs.kind, args.kind),
        eq(reportJobs.status, "revisar"),
      ),
    )
    .returning({ id: reportJobs.id });
  return rows.length;
}

/** The tenant's most recent job of one kind for a document — what the
 * extraction screens read to know whether a hop is in flight, waiting on a
 * human, or finished. Newest first, because a document may have been
 * re-extracted after a recalibration (§12.8) and the LAST answer is the one
 * the UI is about. */
export async function loadLatestJobForDocument(
  dbHandle: DbLike,
  tenantId: string,
  documentId: string,
  kind: JobKind,
): Promise<JobRow | undefined> {
  const rows = await dbHandle
    .select()
    .from(reportJobs)
    .where(
      and(
        eq(reportJobs.tenantId, tenantId),
        eq(reportJobs.documentId, documentId),
        eq(reportJobs.kind, kind),
      ),
    )
    .orderBy(desc(reportJobs.createdAt))
    .limit(1);
  return rows[0];
}
