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
import {
  S3Client,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
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

/**
 * Thrown by `getDocumentBytes` for an object over `MAX_UPLOAD_BYTES` — a
 * fact about the object, not a missing-object outcome, so it is a throw
 * rather than folded into the `null` case.
 */
export class DocumentTooLargeError extends Error {
  override readonly name = "DocumentTooLargeError";
}

/**
 * Reads a tenant document's bytes, or `null` if it is not there.
 *
 * Tier 1 detection (decisions §3.3, §12.2) needs the whole PDF, not a range:
 * page-1 text extraction is done LOCALLY in this Lambda by a bundled JS
 * library (api/detection/page-text.ts) rather than over a relay hop, and that
 * only works if the bytes are already in hand. The `TenantDocumentsReadWrite`
 * grant in template.yaml (`s3:GetObject` on `org_*`) is what makes this call
 * reachable without leaving the VPC — the free S3 gateway endpoint, no NAT.
 *
 * `assertPlainKey` only proves shape, not ownership — same split as
 * `headDocument`. Every caller here already reached `key` through a tenant-
 * scoped `documents` row, so re-deriving ownership from the key itself would
 * just repeat a check the row lookup already made.
 *
 * CAPPED AT `MAX_UPLOAD_BYTES` (§12.5's own upload cap — an object under a
 * tenant's own key can never legitimately exceed it), checked BEFORE the body
 * is streamed. Same reasoning as `MAX_RESULT_BYTES` in api/lib/relay.ts: the
 * point of a cap is not to reject an oversized buffer after paying to build
 * it in this Lambda's memory. The decoded length is re-checked afterwards as
 * a backstop for a missing or lying `Content-Length`.
 */
export async function getDocumentBytes(key: string): Promise<Buffer | null> {
  assertPlainKey(key, "key");
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: docsBucket(), Key: key }));
    if (res.Body === undefined) {
      return null;
    }
    if ((res.ContentLength ?? 0) > MAX_UPLOAD_BYTES) {
      throw new DocumentTooLargeError(`document exceeds ${String(MAX_UPLOAD_BYTES)} bytes`);
    }
    const bytes = await res.Body.transformToByteArray();
    if (bytes.length > MAX_UPLOAD_BYTES) {
      throw new DocumentTooLargeError(`document exceeds ${String(MAX_UPLOAD_BYTES)} bytes`);
    }
    return Buffer.from(bytes);
  } catch (err) {
    if (err instanceof DocumentTooLargeError) {
      throw err;
    }
    const name = typeof err === "object" && err !== null ? (err as { name?: unknown }).name : "";
    if (name === "NotFound" || name === "NoSuchKey") {
      return null;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Frozen report HTML (decisions §5.1)
//
// "On publish, the rendered HTML is frozen to S3 and the key stored. What was
// sent is what is archived; editing the shell later cannot retroactively
// change a document someone's customer already received."
//
// A FOURTH PREFIX, `frozen/`, and not the tenant's `org_*` document namespace:
// `org_*` is granted `s3:PutObject` because a PRESIGNED POST is signed with
// this role's credentials, so a browser holding a form for that prefix is
// authorized against the same grant. A published, immutable artifact must not
// live where a presigned upload can land on it.
//
// THE KEY CARRIES A PER-ATTEMPT UUID, and that is a correctness fix rather
// than tidiness (codex review). It used to be `frozen/{tenant}/{report}.html`
// — derived purely from the two ids, so EVERY concurrent publisher of one
// report computed the SAME key. The compare-and-set on `frozen_at` correctly
// picks one winner, but the loser has already PUT, and it may PUT *after* the
// winner's PUT and CAS: same key, so the loser silently overwrites the
// archive the winner's row now points at. Ordering the writes cannot fix it;
// only not sharing the key can. Each attempt therefore writes its own object
// and the CAS stamps THAT key, so `frozen_html_s3_key` names the exact bytes
// the winner produced and nothing can reach them. The loser deletes its own
// orphan (`deleteFrozenReport`). `reports_frozen_html_s3_key_idx` still holds:
// one row, one key.
// ---------------------------------------------------------------------------

/**
 * `frozen/{tenantId}/{reportId}/{attemptId}.html` — server-minted, never
 * client-supplied, and a FRESH key on every call. Two publishers of the same
 * report can therefore never write the same object (see above).
 */
export function frozenReportKey(tenantId: string, reportId: string): string {
  return `frozen/${tenantId}/${reportId}/${randomUUID()}.html`;
}

/**
 * Writes the frozen HTML. Called BEFORE the `frozen_at` stamp
 * (api/services/report-publish.ts): a row with no object is a report the UI
 * calls published and cannot show, which is unrecoverable; an object with no
 * row is an orphan, which the publisher deletes on a lost CAS and which
 * nothing points at either way.
 */
export async function putFrozenReport(key: string, html: string): Promise<void> {
  assertPlainKey(key, "key");
  await s3.send(
    new PutObjectCommand({
      Bucket: docsBucket(),
      Key: key,
      Body: html,
      ContentType: "text/html; charset=utf-8",
      // Nothing in this system serves the object to a browser directly; it is
      // read back through the API. Marking it explicitly anyway so a future
      // presigned GET cannot render attacker-authored prose as same-origin
      // HTML by accident.
      ContentDisposition: "attachment",
    }),
  );
}

/**
 * Deletes one attempt's object. Called ONLY by the publisher that lost the
 * compare-and-set, on the key IT minted — never on a key read from a row, so
 * it cannot delete a live archive even if the caller is confused.
 *
 * Best-effort by design: the caller swallows failures. A leftover orphan is
 * unreferenced bytes; a publish that failed because a cleanup failed would be
 * a worse outcome for the same fact.
 */
export async function deleteFrozenReport(key: string): Promise<void> {
  assertPlainKey(key, "key");
  await s3.send(new DeleteObjectCommand({ Bucket: docsBucket(), Key: key }));
}

/** Reads a frozen report back. `null` when the object is gone — the row still
 * says published, and the screen says so, rather than throwing at a user who
 * did nothing wrong. */
export async function getFrozenReport(key: string): Promise<string | null> {
  assertPlainKey(key, "key");
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: docsBucket(), Key: key }));
    if (res.Body === undefined) {
      return null;
    }
    return await res.Body.transformToString("utf-8");
  } catch (err) {
    const name = typeof err === "object" && err !== null ? (err as { name?: unknown }).name : "";
    if (name === "NotFound" || name === "NoSuchKey") {
      return null;
    }
    throw err;
  }
}
