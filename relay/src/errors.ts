// relay/src/errors.ts
//
// The permanent/transient split, in one place, because every other file in the
// relay has to make the same call and making it twice is how the two answers
// drift apart.
//
// The classification is not cosmetic — it decides who pays for the retry.
// Per decisions §12.1 a retry is a NEW JOB with the attempt number bumped in
// the jobId, enqueued by the collector, not a re-invoke of this Lambda. So the
// relay's job is to CLASSIFY and answer; it never retries a provider call on
// its own. `transient` in a result file is an invitation for the collector to
// enqueue attempt n+1; `permanent` is a refusal of that invitation.
//
// The default is transient, deliberately. An unrecognised fault is the case we
// have the least reason to trust, and the two mistakes are not symmetric: a
// transient answer to a truly permanent fault costs one extra provider call
// and then fails again visibly, while a permanent answer to a truly transient
// fault throws away a report the user is waiting for.

/** A failure that WILL recur on the same input, so another attempt only spends
 * money to reach the same conclusion. This class is the explicit, reviewed list
 * of what does not get another turn — everything else is transient by default. */
export class PermanentError extends Error {
  public override readonly name = "PermanentError";
}

/**
 * Everything except a reviewed permanent failure.
 *
 * Deliberately NOT a list of retryable error codes. Such a list is a denylist,
 * and the failure mode of a denylist is that the case it misses is handled the
 * dangerous way. Here the case it misses is handled the recoverable way.
 */
export function isTransient(err: unknown): boolean {
  return !(err instanceof PermanentError);
}

/** The `error.type` discriminator written into a result file (§6). */
export function errorType(err: unknown): "permanent" | "transient" {
  return isTransient(err) ? "transient" : "permanent";
}

/** Bounded so a provider's multi-kilobyte error body cannot become the result
 * file. 400 characters is enough to name the cause to an operator. */
export function describeError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 400);
}
