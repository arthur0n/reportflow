// relay/src/job.test.ts
//
// The tenant binding (§12.7, §12.11) and the file_id scope (§12.3).
//
// The relay holds s3:GetObject across the whole documents bucket. Everything
// here exists so the tenantId that came out of the job KEY — the one thing the
// payload cannot influence — is the tenantId every path in the payload is
// measured against.

import { describe, it, expect } from "vitest";
import { parseJob, keyOwnerOf, JOB_KINDS } from "./job";
import { PermanentError } from "./errors";

const TENANT = "org_2abcDEF";

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel: "ai",
    kind: "extract",
    tenantId: TENANT,
    provider: "gemini",
    model: "gemini-3.5-flash",
    system: "sistema",
    prompt: "extraia",
    maxTokens: 8192,
    ...over,
  };
}

describe("parseJob — shape", () => {
  it("accepts the canonical payload from §6", () => {
    const job = parseJob(payload(), TENANT);
    expect(job).toMatchObject({
      channel: "ai",
      kind: "extract",
      tenantId: TENANT,
      provider: "gemini",
      maxTokens: 8192,
    });
  });

  it("accepts every job kind, including verify", () => {
    for (const kind of JOB_KINDS) {
      expect(parseJob(payload({ kind }), TENANT).kind).toBe(kind);
    }
    // §12.13 — verify is "just another job kind", not a second channel.
    expect(JOB_KINDS).toContain("verify");
  });

  it("refuses an unknown channel or kind", () => {
    expect(() => parseJob(payload({ channel: "email" }), TENANT)).toThrow(/unknown channel/u);
    expect(() => parseJob(payload({ kind: "summarise" }), TENANT)).toThrow(/unknown job kind/u);
  });

  it("refuses a payload that is not an object", () => {
    expect(() => parseJob("nope", TENANT)).toThrow(PermanentError);
    expect(() => parseJob(null, TENANT)).toThrow(PermanentError);
  });

  // Catches: an unbounded maxTokens forwarded to the provider. §6.2 budgets a
  // whole report at ~$0.28; a bug that asks for millions of tokens should fail
  // the job, not be paid for.
  it("refuses a maxTokens that is not a sane positive integer", () => {
    for (const maxTokens of [0, -1, 1.5, "8192", 10_000_000]) {
      expect(() => parseJob(payload({ maxTokens }), TENANT)).toThrow(PermanentError);
    }
  });

  it("refuses a missing system prompt or user prompt", () => {
    expect(() => parseJob(payload({ prompt: "" }), TENANT)).toThrow(/prompt is required/u);
    expect(() => parseJob(payload({ system: undefined }), TENANT)).toThrow(/system is required/u);
  });
});

describe("parseJob — the tenant binding", () => {
  // THE case. Catches: taking tenantId from the payload. Every field is well
  // formed and the job was legitimately written at jobs/org_a/…; only the
  // binding to the key says it may not read org_b's PDF.
  it("refuses a payload whose tenantId disagrees with the job key", () => {
    expect(() => parseJob(payload({ tenantId: "org_2victim" }), TENANT)).toThrow(
      /does not match the job key/u,
    );
  });

  it("refuses a document key belonging to another tenant", () => {
    expect(() => parseJob(payload({ document: { s3Key: "org_2victim/x.pdf" } }), TENANT)).toThrow(
      PermanentError,
    );
  });

  // Catches: comparing the prefix before refusing traversal. `org_a/../org_b/x`
  // satisfies the owner prefix and then climbs out of it.
  it("refuses a traversal that starts inside the tenant's own prefix", () => {
    expect(() =>
      parseJob(payload({ document: { s3Key: `${TENANT}/../org_2victim/x.pdf` } }), TENANT),
    ).toThrow(PermanentError);
  });

  it("accepts a document key under the tenant's own prefix", () => {
    const job = parseJob(payload({ document: { s3Key: `${TENANT}/abc.pdf` } }), TENANT);
    expect(job.document).toEqual({ s3Key: `${TENANT}/abc.pdf` });
  });

  it("accepts a job with no document at all (hop 2 reads extraction JSON)", () => {
    expect(parseJob(payload(), TENANT).document).toBeUndefined();
  });
});

describe("parseJob — §12.3 file_id scope", () => {
  const fileDoc = { fileId: "files/abc", fileProvider: "gemini", fileKeyOwner: "platform" };

  it("accepts a file id whose provider and key owner match the job", () => {
    const job = parseJob(payload({ document: fileDoc }), TENANT);
    expect(job.document).toEqual(fileDoc);
  });

  // Catches: treating file_id as a universal handle. After a provider swap the
  // stored id is meaningless at the new provider — a 404 at best.
  it("refuses a file id uploaded to a different provider", () => {
    expect(() =>
      parseJob(payload({ document: { ...fileDoc, fileProvider: "anthropic" } }), TENANT),
    ).toThrow(/§12\.3/u);
  });

  // Catches: ignoring key ownership. The same id under a different API key is
  // not the same file, and BYOK is a per-tenant toggle that can flip.
  it("refuses a platform-uploaded file id on a BYOK job", () => {
    expect(() =>
      parseJob(
        payload({
          document: fileDoc,
          ssmParamName: `/reportflow/tenants/${TENANT}/gemini-api-key`,
        }),
        TENANT,
      ),
    ).toThrow(/§12\.3/u);
  });

  it("refuses a document that carries neither s3Key nor fileId", () => {
    expect(() => parseJob(payload({ document: {} }), TENANT)).toThrow(/s3Key or fileId/u);
  });
});

describe("keyOwnerOf", () => {
  // The single source of the §7 fork. Billing forks on the same fact
  // (platform key -> charge with multiplier; BYOK -> owed 0), so two
  // definitions of "whose key" would put a charge on the wrong side.
  it("is platform without a BYOK marker and tenant with one", () => {
    expect(keyOwnerOf(parseJob(payload(), TENANT))).toBe("platform");
    expect(
      keyOwnerOf(
        parseJob(payload({ ssmParamName: `/reportflow/tenants/${TENANT}/gemini-api-key` }), TENANT),
      ),
    ).toBe("tenant");
  });
});
