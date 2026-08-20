// relay/src/secrets.test.ts
//
// §12.7 in test form. The relay's IAM policy grants
// `parameter/reportflow/tenants/*` — every tenant's provider key — because it
// cannot know in advance which tenant it will serve. The guard tested here is
// the ONLY thing between a job and someone else's key, and decisions.md says so
// in as many words: "The IAM wildcard alone is not the guard."
//
// Each case names the broken implementation it catches.

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("@aws-sdk/client-ssm", () => ({
  SSMClient: class {
    public readonly send = h.send;
  },
  GetParameterCommand: class {
    public constructor(public readonly input: { Name: string; WithDecryption?: boolean }) {}
  },
}));

const { paramNameFor, allowedTenantParamName, platformParamName, resolveApiKey, resetKeyCache } =
  await import("./secrets");
const { PermanentError } = await import("./errors");
const { parseJob } = await import("./job");

const TENANT = "org_2abcDEF";
const OTHER = "org_2victim";

/** Built through the real parser, not hand-typed: `paramNameFor` is only ever
 * handed a job that survived `parseJob`, and a test that skips it could pin
 * behaviour on a job shape the relay never actually sees. */
function job(over: Record<string, unknown> = {}): Parameters<typeof paramNameFor>[0] {
  return parseJob(
    {
      channel: "ai",
      kind: "extract",
      tenantId: TENANT,
      provider: "gemini",
      model: "gemini-3.5-flash",
      system: "s",
      prompt: "p",
      maxTokens: 1024,
      ...over,
    },
    TENANT,
  );
}

beforeEach(() => {
  h.send.mockReset();
  resetKeyCache();
});

describe("paramNameFor — platform key", () => {
  it("uses the relay's own isolated subtree when there is no BYOK marker", () => {
    expect(paramNameFor(job())).toBe("/reportflow/relay/prod/gemini-api-key");
    expect(platformParamName("anthropic")).toBe("/reportflow/relay/prod/anthropic-api-key");
  });
});

describe("paramNameFor — the §12.7 guard", () => {
  it("accepts the one path derived from the job's own tenant", () => {
    const allowed = allowedTenantParamName(TENANT, "gemini");
    expect(allowed).toBe(`/reportflow/tenants/${TENANT}/gemini-api-key`);
    expect(paramNameFor(job({ ssmParamName: allowed }))).toBe(allowed);
  });

  // THE case. Catches: trusting ai_credentials.ssm_param_name as written.
  it("refuses another tenant's parameter", () => {
    const foreign = `/reportflow/tenants/${OTHER}/gemini-api-key`;
    expect(() => paramNameFor(job({ ssmParamName: foreign }))).toThrow(PermanentError);
    expect(() => paramNameFor(job({ ssmParamName: foreign }))).toThrow(/may read/u);
  });

  // Catches: `startsWith` instead of equality. Tenant ids that share a prefix
  // are ordinary, not exotic, and a prefix test hands `org_2abcDEFghi`'s key to
  // `org_2abcDEF`.
  it("refuses a parameter under a tenant id that merely starts with this one", () => {
    expect(() =>
      paramNameFor(job({ ssmParamName: `/reportflow/tenants/${TENANT}extra/gemini-api-key` })),
    ).toThrow(PermanentError);
  });

  // Catches: comparing only the tenant segment. A job for gemini must not read
  // the tenant's anthropic key, even though both are that tenant's.
  it("refuses this tenant's key for a different provider", () => {
    expect(() =>
      paramNameFor(job({ ssmParamName: `/reportflow/tenants/${TENANT}/anthropic-api-key` })),
    ).toThrow(PermanentError);
  });

  // Catches: allowing a traversal to climb out of the tenants subtree entirely,
  // e.g. into /reportflow/relay/prod where the PLATFORM key lives.
  it("refuses a traversal out of the tenants subtree", () => {
    expect(() =>
      paramNameFor(
        job({ ssmParamName: `/reportflow/tenants/${TENANT}/../../relay/prod/gemini-api-key` }),
      ),
    ).toThrow(PermanentError);
  });

  it("refuses the platform parameter named explicitly as a BYOK path", () => {
    expect(() =>
      paramNameFor(job({ ssmParamName: "/reportflow/relay/prod/gemini-api-key" })),
    ).toThrow(PermanentError);
  });

  // Catches: interpolating unvalidated segments into the derived path. If the
  // provider could contain a slash, the DERIVED path would itself be a
  // traversal and the equality check would faithfully approve it.
  it("refuses a provider or tenant id that is not a single path segment", () => {
    expect(() => allowedTenantParamName(TENANT, "../relay/prod/gemini")).toThrow(PermanentError);
    expect(() => allowedTenantParamName("a/b", "gemini")).toThrow(PermanentError);
  });
});

describe("resolveApiKey", () => {
  it("fetches with decryption and returns the value", async () => {
    h.send.mockResolvedValue({ Parameter: { Value: "sk-live" } });
    await expect(resolveApiKey(job())).resolves.toBe("sk-live");
    const cmd = h.send.mock.calls[0]?.[0] as { input: { Name: string; WithDecryption?: boolean } };
    expect(cmd.input).toEqual({
      Name: "/reportflow/relay/prod/gemini-api-key",
      WithDecryption: true,
    });
  });

  // §7's "one delta": per-tenant keys are dynamic, so it is GetParameter on
  // first use per tenant, cached in a Map for the container's life.
  it("caches per parameter name for the life of the container", async () => {
    h.send.mockResolvedValue({ Parameter: { Value: "sk-live" } });
    const byok = { ssmParamName: allowedTenantParamName(TENANT, "gemini") };
    await resolveApiKey(job(byok));
    await resolveApiKey(job(byok));
    expect(h.send).toHaveBeenCalledTimes(1);
  });

  // Catches: caching by tenantId. The platform key and a tenant key would
  // collide and one tenant's job would run on the other's key.
  it("does not let the platform key and a tenant key share a cache entry", async () => {
    h.send
      .mockResolvedValueOnce({ Parameter: { Value: "platform" } })
      .mockResolvedValueOnce({ Parameter: { Value: "byok" } });
    await expect(resolveApiKey(job())).resolves.toBe("platform");
    await expect(
      resolveApiKey(job({ ssmParamName: allowedTenantParamName(TENANT, "gemini") })),
    ).resolves.toBe("byok");
  });

  // Catches: collapsing "not configured" into "SSM did not answer". Absent
  // config repeats; an outage does not, and reporting an outage as a config
  // change fails the job instead of retrying it.
  it("treats a missing parameter as permanent", async () => {
    h.send.mockRejectedValue(Object.assign(new Error("nope"), { name: "ParameterNotFound" }));
    await expect(resolveApiKey(job())).rejects.toBeInstanceOf(PermanentError);
  });

  it("leaves an SSM outage transient", async () => {
    h.send.mockRejectedValue(
      Object.assign(new Error("throttled"), { name: "ThrottlingException" }),
    );
    await expect(resolveApiKey(job())).rejects.not.toBeInstanceOf(PermanentError);
  });

  // Catches: sending an empty string to the provider as if it were a key,
  // which surfaces as an opaque 401 rather than as "the parameter is empty".
  it("treats an empty parameter as permanent", async () => {
    h.send.mockResolvedValue({ Parameter: { Value: "" } });
    await expect(resolveApiKey(job())).rejects.toBeInstanceOf(PermanentError);
  });
});
