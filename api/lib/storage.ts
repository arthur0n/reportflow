// api/lib/storage.ts
//
// Presigned access to the documents bucket (decisions §8, §12.5).
//
// The API Lambda has no internet egress, but S3 is reached through the FREE
// gateway endpoint, and presigning is a LOCAL signature computation that makes
// no network call at all. So this works from inside the no-NAT VPC.
//
// Why a POST policy rather than a proxy through the API: a report PDF can run
// several megabytes, API Gateway caps a payload at 10 MB, and base64 in a JSON
// envelope inflates it by a third. Presigning also keeps the bytes off the
// Lambda's billed time.
//
// Why a POST policy rather than a presigned PUT: a presigned PUT signs a
// FIXED set of headers, and `content-length-range` is a POST-policy
// condition — there is no PUT-side equivalent that caps a RANGE rather than
// pinning an exact byte count. The cap (25 MB) and the pinned
// `Content-Type: application/pdf` (§12.5) are both enforced by S3 itself when
// the browser submits the form, before a single byte reaches this API.
//
// The key is minted HERE, server-side, before anything is signed — the client
// never supplies it (§12.5). That is what makes assertOwnedKey meaningful:
// the key is proven to belong to the caller by CONSTRUCTION, not merely by
// the checks below re-affirming it.

import { randomUUID } from "node:crypto";
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { assertOwnedKey, assertPlainKey } from "./object-keys";

const REGION = process.env["AWS_REGION"] ?? "sa-east-1";

/** Matches the presign helper's TTL elsewhere in this codebase family. Long
 * enough for a phone on a bad connection to finish an upload, short enough
 * that a leaked form is not a standing grant. */
export const UPLOAD_URL_TTL_SECONDS = 300;

/** The presign cap from decisions §12.5. 25 MiB, not 25,000,000 bytes. */
export const MAX_UPLOAD_BYTES = 26_214_400;

/** The only content type the documents bucket is meant to hold (§12.5). */
export const REQUIRED_CONTENT_TYPE = "application/pdf";

const s3 = new S3Client({ region: REGION });

/** Exported so api/lib/relay.ts names the same bucket by the same rule. The
 * outbox prefixes (`jobs/`, `results/`) live in this bucket too — a second
 * bucket would buy a second grant and nothing else, since the relay must read
 * the documents anyway. Two copies of this default would drift. */
export function docsBucket(): string {
  const bucket = process.env["DOCS_BUCKET"];
  return bucket !== undefined && bucket.length > 0 ? bucket : "reportflow-docs-prod";
}

/**
 * Composes the key SERVER-side. The client never names an upload target — a
 * client-named key is a client-chosen prefix unless something checks it, and
 * nothing downstream of a presigned form does.
 */
export function newDocumentKey(orgId: string): string {
  return `${orgId}/${randomUUID()}.pdf`;
}

export type PresignedUpload = {
  /** The S3 endpoint the browser POSTs the multipart form to. */
  url: string;
  /** The object key this upload is authorized for — echoed back so the
   * caller can pass it to `confirmUpload` once the POST succeeds. */
  key: string;
  /** Form fields the browser must submit alongside the file, in order,
   * with the file field last. */
  fields: Record<string, string>;
};

/**
 * Mints a key under `orgId`'s own prefix and a POST policy authorizing
 * exactly one PDF, up to `MAX_UPLOAD_BYTES`, at that key.
 */
export async function createPresignedUploadUrl(orgId: string): Promise<PresignedUpload> {
  const key = newDocumentKey(orgId);
  // Defensive, not load-bearing: a server-minted key under `${orgId}/` always
  // passes its own gate. Keeping the call here means the gate runs on every
  // path to a signature, including a future caller that stops minting keys
  // this same way.
  assertOwnedKey(key, orgId, "key");

  const { url, fields } = await createPresignedPost(s3, {
    Bucket: docsBucket(),
    Key: key,
    Conditions: [
      ["content-length-range", 1, MAX_UPLOAD_BYTES],
      { "Content-Type": REQUIRED_CONTENT_TYPE },
    ],
    Fields: {
      "Content-Type": REQUIRED_CONTENT_TYPE,
    },
    Expires: UPLOAD_URL_TTL_SECONDS,
  });

  return { url, key, fields };
}

export type DocumentHead = {
  size: number;
  contentType: string | undefined;
};

/**
 * Whether the object is there, and if so, what it actually is.
 *
 * The POST policy constrains what S3 was willing to ACCEPT; it says nothing
 * about what is there NOW unless something reads it back. `confirmUpload`
 * calls this before trusting anything the client claims about its own
 * upload — size and content type both come from S3, never from the request
 * body.
 */
export async function headDocument(key: string): Promise<DocumentHead | null> {
  assertPlainKey(key, "key");
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: docsBucket(), Key: key }));
    return { size: res.ContentLength ?? 0, contentType: res.ContentType };
  } catch (err) {
    const name = typeof err === "object" && err !== null ? (err as { name?: unknown }).name : "";
    if (name === "NotFound" || name === "NoSuchKey") {
      return null;
    }
    throw err;
  }
}
