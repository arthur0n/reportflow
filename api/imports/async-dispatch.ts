// api/imports/async-dispatch.ts
//
// Where an uploaded statement gets parsed. In Lambda, the HTTP request must
// return well under API Gateway's ~30s cap, so upload only stores the raw
// file in S3; the bucket's ObjectCreated notification re-invokes the same
// function (recognized in api/handler.ts) to do the heavy parse. S3 invokes
// Lambda from outside the VPC — the VPC's only AWS route is the S3 gateway
// endpoint, so a self-invoke via the Lambda API would time out. The local
// dev server has no gateway cap and parses inline.

import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";

type S3EventRecord = { s3: { object: { key: string } } };

export type UploadObjectRef = { s3Key: string; tenantId: string; importId: string };

export function isS3UploadEvent(event: unknown): event is { Records: S3EventRecord[] } {
  if (typeof event !== "object" || event === null) return false;
  const records = (event as Record<string, unknown>)["Records"];
  if (!Array.isArray(records) || records.length === 0) return false;
  const first: unknown = records[0];
  return typeof first === "object" && first !== null && "s3" in first;
}

/**
 * Recover the upload identity from the object key
 * (`uploads/<tenantId>/<importId>/<fileName>`). Keys arrive URL-encoded in
 * S3 events. Returns null for keys outside the expected shape.
 */
export function parseUploadKey(rawKey: string): UploadObjectRef | null {
  const s3Key = decodeURIComponent(rawKey.replace(/\+/g, " "));
  const parts = s3Key.split("/");
  const [prefix, tenantId, importId] = parts;
  if (prefix !== "uploads" || tenantId === undefined || importId === undefined) return null;
  if (parts.length < 4) return null;
  return { s3Key, tenantId, importId };
}

export function uploadEventRefs(event: { Records: S3EventRecord[] }): UploadObjectRef[] {
  return event.Records.map((r) => parseUploadKey(r.s3.object.key)).filter(
    (ref): ref is UploadObjectRef => ref !== null,
  );
}

export function isLambdaRuntime(): boolean {
  return process.env["AWS_LAMBDA_FUNCTION_NAME"] !== undefined;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required in the Lambda environment`);
  }
  return value;
}

let s3: S3Client | null = null;

function s3Client(): S3Client {
  s3 ??= new S3Client({});
  return s3;
}

export async function storeUploadFile(s3Key: string, fileBuffer: Buffer): Promise<void> {
  await s3Client().send(
    new PutObjectCommand({
      Bucket: requireEnv("UPLOADS_BUCKET"),
      Key: s3Key,
      Body: fileBuffer,
    }),
  );
}

export async function loadUploadFile(s3Key: string): Promise<Buffer> {
  const result = await s3Client().send(
    new GetObjectCommand({ Bucket: requireEnv("UPLOADS_BUCKET"), Key: s3Key }),
  );
  if (result.Body === undefined) throw new Error(`empty S3 object: ${s3Key}`);
  return Buffer.from(await result.Body.transformToByteArray());
}
