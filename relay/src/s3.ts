// relay/src/s3.ts
//
// Every S3 call the relay makes, behind names that say what the call is FOR.
// One client, because a Lambda container should hold one connection pool, and
// one place to map S3's error vocabulary onto ours.

import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { PermanentError } from "./errors";

const REGION = process.env["AWS_REGION"] ?? "sa-east-1";

const s3 = new S3Client({ region: REGION });

/**
 * The documents bucket. Same default as api/lib/storage.ts — one bucket, not
 * one per environment (§8, §12.5) — and the same bucket the outbox prefixes
 * live in, which is why the relay needs no second grant.
 */
export function docsBucket(): string {
  const bucket = process.env["DOCS_BUCKET"];
  return bucket !== undefined && bucket.length > 0 ? bucket : "reportflow-docs-prod";
}

function errorName(err: unknown): string {
  const name = typeof err === "object" && err !== null ? (err as { name?: unknown }).name : "";
  return typeof name === "string" ? name : "";
}

/** True when the object is not there, false when it is. Anything else is a real
 * S3 failure and is rethrown: swallowing it would mean paying for a provider
 * call again on the strength of a call that never answered. */
export function isMissing(err: unknown): boolean {
  const name = errorName(err);
  return name === "NotFound" || name === "NoSuchKey";
}

export async function readText(bucket: string, key: string): Promise<string> {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (out.Body === undefined) {
    throw new PermanentError(`empty object: ${key}`);
  }
  return out.Body.transformToString();
}

export async function readBase64(bucket: string, key: string): Promise<string> {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (out.Body === undefined) {
    throw new PermanentError(`empty object: ${key}`);
  }
  return Buffer.from(await out.Body.transformToByteArray()).toString("base64");
}

export async function exists(bucket: string, key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch (err) {
    if (isMissing(err)) {
      return false;
    }
    throw err;
  }
}

/**
 * Writes the object only if nothing is there, and reports which happened.
 *
 * `IfNoneMatch: "*"` is S3's create-if-absent. This is the whole idempotency
 * story for results: S3 events are at-least-once, so two deliveries of the same
 * job can both reach this line, and exactly one of them gets to answer. The
 * loser is told `false` rather than being thrown at, because losing this race
 * is the SYSTEM WORKING — the result the winner wrote is the same result — and
 * a thrown error would send a healthy duplicate to the retry path.
 */
export async function putIfAbsent(bucket: string, key: string, body: string): Promise<boolean> {
  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: "application/json",
        IfNoneMatch: "*",
      }),
    );
    return true;
  } catch (err) {
    const name = errorName(err);
    if (name === "PreconditionFailed" || name === "ConditionalRequestConflict") {
      return false;
    }
    throw err;
  }
}

/** Best effort. A job object left behind is expired by the bucket's one-day
 * lifecycle rule, and throwing here would mask the outcome already written. */
export async function deleteQuietly(bucket: string, key: string): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (err) {
    console.error("[relay] could not delete object", { key, err });
  }
}
