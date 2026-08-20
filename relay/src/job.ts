// relay/src/job.ts
//
// The canonical job payload (decisions §6) and the parser that refuses anything
// which is not it.
//
// §6 in one line: the API imports ZERO AI SDKs and never sees a key. It emits
// this object, and the relay's adapter registry maps it onto whichever provider
// was named. Swapping providers never touches the API, the schema, or the
// frontend — which is only true for as long as this type stays provider-neutral,
// so nothing here may name a provider's own vocabulary.
//
// Why a parser at all, given §12.11 says the API is the sole writer under
// `jobs/`? Two reasons, neither of them "the caller might be hostile":
//
//   1. The `tenantId` binding. The relay holds s3:GetObject across the docs
//      bucket, because it cannot know in advance whose PDF it will be asked to
//      read. The only thing between that grant and a cross-tenant read is that
//      the tenantId in the job KEY and the paths in the job PAYLOAD agree. A
//      well-formed payload is not enough; it has to be BOUND to the key.
//   2. Cost. The caps below are not an injection defence — they bound what a
//      BUG can send. A runaway prompt should fail the job, not be paid for on
//      every attempt.

import { assertOwnedKey, ObjectKeyError } from "./lib/object-keys";
import { PermanentError } from "./errors";

/** §6 hops plus §12.13's adversarial verify, which is "just another job kind"
 * and deliberately not a second channel. */
export const JOB_KINDS = ["detect", "extract", "analyse", "verify"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

const MAX_PROMPT = 262_144;
const MAX_SYSTEM = 32_768;
const MAX_SCHEMA = 65_536;
const MAX_FIELD = 256;
/** Above this a single call costs more than a whole report is supposed to
 * (§6.2 budgets ~$0.28 end to end), so a larger value is a bug, not a request. */
const MAX_MAX_TOKENS = 200_000;

/**
 * Whose key paid for the upload. Load-bearing for §12.3: a provider `file_id`
 * is scoped to (provider, API key owner), so the same id under a different key
 * is not the same handle — it is a 404 at best and someone else's document at
 * worst.
 */
export type KeyOwner = "platform" | "tenant";

/** A document already uploaded to the docs bucket. Must sit under the job's own
 * tenant prefix; enforced in `parseJob`, not by the type. */
export interface DocumentByKey {
  readonly s3Key: string;
}

/**
 * A document already uploaded to the PROVIDER's Files API (§4, §12.3).
 *
 * `fileProvider` and `fileKeyOwner` are carried alongside the id rather than
 * inferred, because §12.3's correction is precisely that a `file_id` is not a
 * universal handle. The relay re-checks them against the job it arrived on, so
 * a stale row that outlived a provider swap or a BYOK toggle fails loudly here
 * instead of resolving to nothing (or to something) at the provider.
 */
export interface DocumentByFileId {
  readonly fileId: string;
  readonly fileProvider: string;
  readonly fileKeyOwner: KeyOwner;
}

export type DocumentRef = DocumentByKey | DocumentByFileId;

export interface AiJob {
  readonly channel: "ai";
  readonly kind: JobKind;
  /** Clerk `org_id`. Always the value parsed out of the job KEY — `parseJob`
   * refuses a payload that disagrees rather than preferring one of them. */
  readonly tenantId: string;
  readonly provider: string;
  readonly model: string;
  readonly system: string;
  readonly prompt: string;
  readonly document?: DocumentRef;
  /** Provider-neutral JSON Schema derived from the frozen field list (§3.1).
   * Each adapter translates it into its own dialect; absent for a free-text hop. */
  readonly schema?: Record<string, unknown>;
  readonly maxTokens: number;
  /**
   * BYOK marker (§7). Present = the tenant pays the provider directly with
   * their own key; absent = the platform key. The relay does not TRUST this
   * path — it derives the only allowed one from `tenantId` and refuses
   * anything else (§12.7, see secrets.ts).
   */
  readonly ssmParamName?: string;
}

/** Whose key this job will be billed to. The single source of the fork, so
 * secrets.ts and the §12.3 check cannot disagree about it. */
export function keyOwnerOf(job: AiJob): KeyOwner {
  return job.ssmParamName === undefined ? "platform" : "tenant";
}

function requireString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PermanentError(`${label} is required`);
  }
  if (value.length > max) {
    throw new PermanentError(`${label} is too long`);
  }
  return value;
}

function requireMaxTokens(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new PermanentError("maxTokens must be a positive integer");
  }
  if (value > MAX_MAX_TOKENS) {
    throw new PermanentError("maxTokens is too large");
  }
  return value;
}

function parseSchema(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PermanentError("schema must be an object");
  }
  if (JSON.stringify(value).length > MAX_SCHEMA) {
    throw new PermanentError("schema is too long");
  }
  return value as Record<string, unknown>;
}

/**
 * The ownership check for a document key. The predicate itself lives in
 * `lib/object-keys.ts`, mirrored byte-for-byte from `api/lib/object-keys.ts`
 * (see `lib/object-keys.test.ts`) because both sides guard the same bucket with
 * the same rule and two copies of that rule drift. Only the error VOCABULARY is
 * local: a bad key is permanent here, so it is answered rather than retried.
 */
function assertOwnedDocument(s3Key: unknown, tenantId: string): string {
  try {
    return assertOwnedKey(s3Key, tenantId, "document.s3Key");
  } catch (err) {
    if (err instanceof ObjectKeyError) {
      throw new PermanentError(err.message);
    }
    throw err;
  }
}

function parseDocument(
  value: unknown,
  job: { tenantId: string; provider: string; owner: KeyOwner },
): DocumentRef | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PermanentError("document must be an object");
  }
  const doc = value as Record<string, unknown>;
  if (doc["s3Key"] !== undefined) {
    return { s3Key: assertOwnedDocument(doc["s3Key"], job.tenantId) };
  }
  if (doc["fileId"] === undefined) {
    throw new PermanentError("document must carry either s3Key or fileId");
  }
  const fileId = requireString(doc["fileId"], "document.fileId", MAX_FIELD);
  const fileProvider = requireString(doc["fileProvider"], "document.fileProvider", MAX_FIELD);
  const fileKeyOwner = doc["fileKeyOwner"];
  if (fileKeyOwner !== "platform" && fileKeyOwner !== "tenant") {
    throw new PermanentError("document.fileKeyOwner must be platform or tenant");
  }
  // §12.3 — a file_id is scoped to (provider, API key owner). Using one outside
  // that scope is not a smaller mistake than using another tenant's S3 key; it
  // just fails less obviously.
  if (fileProvider !== job.provider) {
    throw new PermanentError(
      `document.fileId belongs to ${fileProvider}, not ${job.provider} — re-upload (§12.3)`,
    );
  }
  if (fileKeyOwner !== job.owner) {
    throw new PermanentError(
      `document.fileId was uploaded with the ${fileKeyOwner} key, this job uses the ${job.owner} key — re-upload (§12.3)`,
    );
  }
  return { fileId, fileProvider, fileKeyOwner };
}

/**
 * `tenantId` comes from the KEY, never from the payload. A payload that names a
 * different tenant is refused rather than silently overridden: the API is the
 * only writer under `jobs/` (§12.11), so a disagreement is a bug in the API and
 * quietly repairing it would hide the bug while the repaired job still ran.
 */
export function parseJob(raw: unknown, tenantId: string): AiJob {
  if (typeof raw !== "object" || raw === null) {
    throw new PermanentError("job payload is not an object");
  }
  const e = raw as Record<string, unknown>;
  if (e["channel"] !== "ai") {
    throw new PermanentError(`unknown channel: ${String(e["channel"])}`);
  }
  const kind = e["kind"];
  if (typeof kind !== "string" || !(JOB_KINDS as readonly string[]).includes(kind)) {
    throw new PermanentError(`unknown job kind: ${String(kind)}`);
  }
  if (e["tenantId"] !== tenantId) {
    throw new PermanentError(
      `job payload tenantId does not match the job key (${String(e["tenantId"])})`,
    );
  }
  const provider = requireString(e["provider"], "provider", MAX_FIELD);
  const model = requireString(e["model"], "model", MAX_FIELD);
  const prompt = requireString(e["prompt"], "prompt", MAX_PROMPT);
  const system = requireString(e["system"], "system", MAX_SYSTEM);
  const maxTokens = requireMaxTokens(e["maxTokens"]);
  const ssmParamName =
    e["ssmParamName"] === undefined
      ? undefined
      : requireString(e["ssmParamName"], "ssmParamName", MAX_FIELD);
  const owner: KeyOwner = ssmParamName === undefined ? "platform" : "tenant";
  const document = parseDocument(e["document"], { tenantId, provider, owner });
  const schema = parseSchema(e["schema"]);

  return {
    channel: "ai",
    kind: kind as JobKind,
    tenantId,
    provider,
    model,
    system,
    prompt,
    maxTokens,
    ...(document === undefined ? {} : { document }),
    ...(schema === undefined ? {} : { schema }),
    ...(ssmParamName === undefined ? {} : { ssmParamName }),
  };
}
