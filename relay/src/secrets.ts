// relay/src/secrets.ts
//
// Where the relay gets a provider API key, and the guard that decides WHICH key
// it is allowed to get (decisions §7, §12.7).
//
// Two sources, forked on key ownership:
//
//   platform key  →  /reportflow/relay/{env}/{provider}-api-key
//   BYOK          →  /reportflow/tenants/{tenantId}/{provider}-api-key
//
// The IAM policy carries `parameter/reportflow/tenants/*`, because the relay
// cannot know in advance which tenant it will serve. THAT WILDCARD IS NOT THE
// GUARD — §12.7 says so in as many words. Under it, every tenant's key is
// readable by this function, and the only thing separating a job from another
// tenant's key is the check below: the allowed path is DERIVED from the
// tenantId parsed out of the job KEY, and a `ssmParamName` that is not exactly
// equal to it is refused.
//
// Equality, not `startsWith`. A prefix test on
// `/reportflow/tenants/org_abc` also passes `/reportflow/tenants/org_abcdef/...`,
// and ids that share a prefix are ordinary rather than exotic. The database
// column exists so an operator can point a tenant at a differently NAMED
// parameter later; until then, a stored name that disagrees with the derived
// one is a corrupted row, and reading the key anyway would be reading it on the
// strength of the corruption.
//
// The parameter NAME is not a secret (§7: "the database stores only the
// parameter name ... an RDS snapshot is worthless to an attacker"), so it is
// safe to name in an error message. The VALUE never appears in a log line here.

import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { PermanentError } from "./errors";
import { isSegment } from "./keys";
import { keyOwnerOf, type AiJob } from "./job";

const REGION = process.env["AWS_REGION"] ?? "sa-east-1";

/** Set by the SAM template to `/reportflow/relay/${Environment}`. */
const SSM_PREFIX = process.env["SSM_PREFIX"] ?? "/reportflow/relay/prod";

/** §7. Fixed here rather than read from the environment: it is half of the
 * guard, and a guard whose shape comes from configuration can be widened by
 * changing configuration. */
const TENANT_PREFIX = "/reportflow/tenants";

const ssm = new SSMClient({ region: REGION });

/**
 * Container-lifetime cache, keyed by the FULL parameter name.
 *
 * §7's "one delta from the existing pattern": the template prefetches a known
 * leaf set under a static prefix at cold start, but per-tenant keys are dynamic,
 * so this is GetParameter on first use per tenant, cached in a Map. Keyed by
 * the resolved name and not by tenantId, so the platform key and a tenant key
 * can never collide in it.
 */
const keyCache = new Map<string, string>();

/**
 * Empties the warm-container cache, which is what a COLD start does.
 *
 * Exported for tests, and not incidental: anything asserting on how a key is
 * fetched has to say which container state it means, because a warm container
 * legitimately never calls SSM at all. A test that forgets this passes against
 * a value cached by an earlier test and proves nothing about the code it names.
 */
export function resetKeyCache(): void {
  keyCache.clear();
}

/** The ONLY BYOK parameter path a job for this tenant and provider may name. */
export function allowedTenantParamName(tenantId: string, provider: string): string {
  if (!isSegment(tenantId)) {
    throw new PermanentError(`tenantId is not a single path segment: ${tenantId}`);
  }
  if (!isSegment(provider)) {
    throw new PermanentError(`provider is not a single path segment: ${provider}`);
  }
  return `${TENANT_PREFIX}/${tenantId}/${provider}-api-key`;
}

/** The platform key for a provider, under the relay's own isolated subtree. */
export function platformParamName(provider: string): string {
  if (!isSegment(provider)) {
    throw new PermanentError(`provider is not a single path segment: ${provider}`);
  }
  return `${SSM_PREFIX}/${provider}-api-key`;
}

/**
 * Resolves the parameter name for a job, applying the §12.7 guard.
 *
 * Split out from the fetch so the guard is testable without SSM, and so the
 * decision "which parameter" is visible in one expression rather than
 * distributed through an async function.
 */
export function paramNameFor(job: AiJob): string {
  if (keyOwnerOf(job) === "platform") {
    return platformParamName(job.provider);
  }
  const allowed = allowedTenantParamName(job.tenantId, job.provider);
  if (job.ssmParamName !== allowed) {
    throw new PermanentError(
      `ssmParamName ${String(job.ssmParamName)} is not the parameter this tenant may read (${allowed})`,
    );
  }
  return allowed;
}

/** An SSM read that failed because the parameter is not there, as opposed to
 * one that failed because SSM did not answer. Absent config is permanent; an
 * outage is not, and collapsing the two reports an outage as a config change. */
function isParameterMissing(err: unknown): boolean {
  const name = typeof err === "object" && err !== null ? (err as { name?: unknown }).name : "";
  return name === "ParameterNotFound" || name === "ParameterVersionNotFound";
}

async function fetchParameter(name: string): Promise<string> {
  const cached = keyCache.get(name);
  if (cached !== undefined) {
    return cached;
  }
  let value: string | undefined;
  try {
    const out = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    value = out.Parameter?.Value;
  } catch (err) {
    if (isParameterMissing(err)) {
      throw new PermanentError(`SSM ${name} does not exist`);
    }
    // An outage. Transient by default, so the collector may enqueue attempt n+1.
    throw err;
  }
  if (value === undefined || value.length === 0) {
    throw new PermanentError(`SSM ${name} is empty`);
  }
  keyCache.set(name, value);
  return value;
}

/** The key this job is allowed to use, decrypted and cached. */
export async function resolveApiKey(job: AiJob): Promise<string> {
  return fetchParameter(paramNameFor(job));
}
