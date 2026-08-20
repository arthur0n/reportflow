// api/lib/storage.test.ts
//
// getDocumentBytes's own cap (codex review, 2026-08-20): tier 1 detection
// downloads a whole tenant document into this Lambda's memory
// (api/detection/page-text.ts), so an object over the upload cap must be
// refused BEFORE its body is streamed, not after. Mirrors the two-layer cap
// api/lib/relay.ts applies to a relay result (`MAX_RESULT_BYTES`): the
// `ContentLength` header first, then the decoded length as a backstop for a
// missing or lying header.
//
// The S3 client is mocked — no network, and the interesting behaviour here is
// the CAP DECISION, not the AWS SDK call shape.

import { describe, it, expect, vi, beforeEach } from "vitest";

const s3 = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    public readonly send = s3.send;
  },
  GetObjectCommand: class {
    public constructor(public readonly input: unknown) {}
  },
  HeadObjectCommand: class {
    public constructor(public readonly input: unknown) {}
  },
  PutObjectCommand: class {
    public constructor(public readonly input: unknown) {}
  },
  DeleteObjectCommand: class {
    public constructor(public readonly input: unknown) {}
  },
}));

const { getDocumentBytes, DocumentTooLargeError, MAX_UPLOAD_BYTES, frozenReportKey } =
  await import("./storage");

const KEY = "org_2abcTENANT/11111111-1111-4111-8111-111111111111.pdf";

beforeEach(() => {
  s3.send.mockReset();
});

describe("getDocumentBytes", () => {
  it("returns null when the object has no body", async () => {
    s3.send.mockResolvedValue({ ContentLength: 10 });
    const result = await getDocumentBytes(KEY);
    expect(result).toBeNull();
  });

  it("returns null when S3 reports the object missing", async () => {
    const err = Object.assign(new Error("nope"), { name: "NoSuchKey" });
    s3.send.mockRejectedValue(err);
    const result = await getDocumentBytes(KEY);
    expect(result).toBeNull();
  });

  it("returns the bytes for an ordinary object under the cap", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    s3.send.mockResolvedValue({
      ContentLength: bytes.length,
      Body: { transformToByteArray: vi.fn().mockResolvedValue(bytes) },
    });
    const result = await getDocumentBytes(KEY);
    expect(result).toEqual(Buffer.from(bytes));
  });

  it("rejects an object over the cap BEFORE streaming the body", async () => {
    const transformToByteArray = vi.fn();
    s3.send.mockResolvedValue({
      ContentLength: MAX_UPLOAD_BYTES + 1,
      Body: { transformToByteArray },
    });
    await expect(getDocumentBytes(KEY)).rejects.toBeInstanceOf(DocumentTooLargeError);
    expect(transformToByteArray).not.toHaveBeenCalled();
  });

  it("rejects via the decoded-length backstop when ContentLength is missing or lying", async () => {
    const oversized = new Uint8Array(MAX_UPLOAD_BYTES + 1);
    s3.send.mockResolvedValue({
      // No ContentLength at all — the header lied or was stripped.
      Body: { transformToByteArray: vi.fn().mockResolvedValue(oversized) },
    });
    await expect(getDocumentBytes(KEY)).rejects.toBeInstanceOf(DocumentTooLargeError);
  });

  it("propagates an unexpected S3 error instead of swallowing it", async () => {
    s3.send.mockRejectedValue(new Error("access denied"));
    await expect(getDocumentBytes(KEY)).rejects.toThrow("access denied");
  });
});

// ---------------------------------------------------------------------------
// frozenReportKey — a PER-ATTEMPT key (§5.1, codex review).
//
// The key used to be derived purely from (tenant, report), so every concurrent
// publisher of one report computed the same key. The `frozen_at` compare-and-
// set correctly picks one winner, but nothing orders the loser's PutObject
// before the winner's: a slow loser overwrote the archive the winner's row
// already pointed at, after publication. Only not sharing the key fixes it.
// ---------------------------------------------------------------------------

describe("frozenReportKey", () => {
  const TENANT = "org_2abcTENANT";
  const REPORT = "44444444-4444-4444-8444-444444444444";

  it("never returns the same key twice for one report", () => {
    const keys = new Set(Array.from({ length: 50 }, () => frozenReportKey(TENANT, REPORT)));
    expect(keys.size).toBe(50);
  });

  it("stays under the frozen/ prefix and keeps the tenant and report attributable", () => {
    const key = frozenReportKey(TENANT, REPORT);
    // The IAM grant is on `frozen/*` — a key outside it is a publish that
    // fails at PutObject rather than a silent one.
    expect(key.startsWith(`frozen/${TENANT}/${REPORT}/`)).toBe(true);
    expect(key.endsWith(".html")).toBe(true);
  });

  it("is a plain object key — no traversal, no leading slash", () => {
    const key = frozenReportKey(TENANT, REPORT);
    expect(key.includes("..")).toBe(false);
    expect(key.startsWith("/")).toBe(false);
  });
});
