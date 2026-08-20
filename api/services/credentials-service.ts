// api/services/credentials-service.ts
//
// WHOSE KEY PAYS, AND WHICH MODEL RUNS (decisions §6 "Model scope", §7).
//
// Every hop that spends money used to name its own provider/model constants
// and each carried the same TODO pointing at this ticket. They now all ask
// this function, and it is the ONLY place `ai_credentials` is read on the hot
// path — so a per-hop or per-template column, when the schema grows one, is a
// change here and nowhere else.
//
// WHAT THE SCHEMA ACTUALLY SUPPORTS TODAY, stated plainly rather than wished
// away. `ai_credentials` is `unique(tenant_id, provider)` with three columns
// that matter: `provider`, `model`, `ssm_param_name`
// (drizzle/tables/billing.ts). That expresses §6's ACCOUNT-LEVEL DEFAULT and
// §7's key ownership, and it does not express a per-hop or per-template
// override — there is no column for either. So:
//
//   * the platform default per hop is the constant table below (§6: extraction
//     is accuracy-critical, analysis is prose, detection is trivial);
//   * an `ai_credentials` row for that provider overrides the MODEL at the
//     account level and decides KEY OWNERSHIP;
//   * per-template and per-hop overrides are NOT implemented, because
//     implementing them would mean inventing columns in a ticket that is
//     supposed to be wiring the ones that exist. The `hop` argument is already
//     the seam they arrive through.
//
// ONE HOP DOES NOT TAKE THE ACCOUNT MODEL OVERRIDE, AND THAT IS DELIBERATE.
// §12.13 requires the verifier to be "a DIFFERENT model than the generator
// (different family; cross-provider once a second provider key is
// configured)". A single account-level `model` column cannot express two
// models, so applying it to `verify` would collapse the adversary onto the
// thing it is auditing and quietly delete the entire guarantee. The account's
// KEY still applies to `verify` — that is about who pays, not about who
// checks — only the model does not.
//
// AND THE BYOK PARAMETER NAME IS RE-DERIVED, NOT TRUSTED (§12.7). The relay
// already refuses any `ssmParamName` outside `/reportflow/tenants/{org}/…`, and
// the `ai_credentials` CHECK constraint pins the prefix — but a prefix is not a
// path. A row naming ANOTHER tenant's parameter passes both and produces a job
// the relay throws away as a PermanentError, after the API has written a job
// object and a `report_jobs` row for it. So the exact name is recomputed here
// from (tenantId, provider) and a mismatch is a CONFIGURATION error reported at
// the API boundary: never enqueue a job that cannot succeed.
//
// AND UNPRICED IS REFUSED HERE, BEFORE THE MONEY IS SPENT. §7 says
// `isPricedModel()` is enforced on the platform-key path; api/billing/charge.ts
// enforces it at the ledger, which is the invariant. Enforcing it HERE too is
// what makes the refusal cost nothing: a hop that cannot be billed is a hop
// that must not run, and discovering that after the provider call means the
// business ate the cost to learn it. §10.5 calls this the intended fail-closed
// behaviour and names the fix — one line in COST_OF_GOODS.

import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { aiCredentials } from "../../drizzle/schema";
import { isPricedModel } from "../billing/cost-of-goods";
import type { DbLike } from "../collector/job-state";

/**
 * The hops that spend money. NOT the same vocabulary as
 * `ai_charges.source` — `calibrate` rides the `analyse` job kind and is billed
 * as `analyse` (api/calibration/propose-job.ts explains why it is not its own
 * kind), but it is its own MODEL choice: it reads a whole document and has to
 * invent a field list from it, which the flash-lite tier is a false economy
 * for.
 */
export type Hop = "detect" | "extract" | "analyse" | "verify" | "calibrate";

export interface PlatformModel {
  readonly provider: string;
  readonly model: string;
}

/**
 * §6's per-hop defaults, all pinned to the tier the POC's corpus was actually
 * validated against (poc/lib/ai.ts `MODEL_EXTRACT` / `MODEL_ANALYSE` /
 * `MODEL_VERIFY`). Only adapter registered today is gemini
 * (relay/src/providers/registry.ts).
 */
export const PLATFORM_DEFAULTS: Readonly<Record<Hop, PlatformModel>> = {
  // Trivial: pick one of N labels. The cheapest tier there is.
  detect: { provider: "gemini", model: "gemini-3.5-flash-lite" },
  // Accuracy-critical (§6). The flash tier, not flash-lite.
  extract: { provider: "gemini", model: "gemini-3.5-flash" },
  // Prose around figures it is HANDED (§12.12b). Never the source of a number.
  analyse: { provider: "gemini", model: "gemini-3.5-flash-lite" },
  // §12.13 — a DIFFERENT family from the generator, by construction.
  verify: { provider: "gemini", model: "gemini-3.1-pro-preview" },
  // One call per document type, ever. Same tier as extraction.
  calibrate: { provider: "gemini", model: "gemini-3.5-flash" },
};

/** Hops whose model an account-level override may replace. See the header on
 * why `verify` is not one of them. */
const MODEL_OVERRIDABLE: ReadonlySet<Hop> = new Set<Hop>([
  "detect",
  "extract",
  "analyse",
  "calibrate",
]);

/**
 * The ONE BYOK parameter path a tenant may name, restated on the API side.
 *
 * A THIRD statement of the same rule, deliberately: relay/src/secrets.ts
 * `allowedTenantParamName` is the enforcement (the relay is the only component
 * that ever holds a key), drizzle/tables/billing.ts's CHECK pins the prefix in
 * the database, and this one exists so the API refuses a doomed job instead of
 * paying to discover the misconfiguration. The two bundles cannot import each
 * other; api/services/credentials-service.test.ts pins that they still agree.
 */
export function allowedTenantParamName(tenantId: string, provider: string): string {
  return `/reportflow/tenants/${tenantId}/${provider}-api-key`;
}

export interface ResolvedModel {
  readonly provider: string;
  readonly model: string;
  /**
   * `null` → platform key: raw = costFor(...), owed = raw × mult,
   * `isPricedModel` enforced. Set → BYOK: raw = 0, owed = 0, any model
   * allowed, and the relay fetches THIS parameter (§7, §12.7). The API never
   * sees the key itself, only its name — which is not a secret.
   */
  readonly byok: { readonly ssmParamName: string } | null;
}

/**
 * The account's credential row for one provider, or `undefined`.
 *
 * Tenant-scoped even though `(tenant_id, provider)` is unique: the uniqueness
 * makes the predicate redundant, not unnecessary — it is the rule this
 * codebase keeps everywhere, including where a constraint would have covered
 * it.
 */
async function loadCredential(
  dbHandle: DbLike,
  tenantId: string,
  provider: string,
): Promise<{ model: string | null; ssmParamName: string | null } | undefined> {
  const rows = await dbHandle
    .select({ model: aiCredentials.model, ssmParamName: aiCredentials.ssmParamName })
    .from(aiCredentials)
    .where(and(eq(aiCredentials.tenantId, tenantId), eq(aiCredentials.provider, provider)))
    .limit(1);
  return rows[0];
}

/**
 * (provider, model, key ownership) for one hop of one account.
 *
 * Falls back to `PLATFORM_DEFAULTS[hop]` in full when the account has no row
 * for that provider — which is every account until somebody configures one,
 * and is why this never needs to be null-checked upstream.
 *
 * THROWS, and only for one reason: a platform-key hop on a model nobody has
 * priced. See the header.
 */
export async function resolveModel(
  dbHandle: DbLike,
  tenantId: string,
  hop: Hop,
): Promise<ResolvedModel> {
  const fallback = PLATFORM_DEFAULTS[hop];
  const row = await loadCredential(dbHandle, tenantId, fallback.provider);

  const model =
    MODEL_OVERRIDABLE.has(hop) && row?.model != null && row.model.length > 0
      ? row.model
      : fallback.model;
  const ssmParamName = row?.ssmParamName ?? null;
  if (ssmParamName !== null) {
    // §12.7 — re-derived, never trusted. See the header.
    const allowed = allowedTenantParamName(tenantId, fallback.provider);
    if (ssmParamName !== allowed) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message:
          `A credencial de ${fallback.provider} desta conta aponta para um parâmetro inválido. ` +
          `O único parâmetro permitido é ${allowed}. Nenhuma chamada foi feita — ` +
          `corrija a configuração da credencial.`,
      });
    }
  }
  const byok = ssmParamName === null ? null : { ssmParamName };

  if (byok === null && !isPricedModel(fallback.provider, model)) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message:
        `Não há preço configurado para o modelo ${fallback.provider}/${model} ` +
        `(etapa "${hop}"). Nenhuma chamada foi feita — configure a tabela de custos ` +
        `ou use uma chave própria (BYOK).`,
    });
  }

  return { provider: fallback.provider, model, byok };
}

/**
 * The BYOK half of a canonical job payload (§6, §12.7), spread by every job
 * builder.
 *
 * The relay reads `ssmParamName` and independently re-derives the ONLY path
 * this tenant may name (`/reportflow/tenants/{org}/{provider}-api-key`,
 * relay/src/secrets.ts `allowedTenantParamName`) — so this is a request, not
 * an authorization. Absent means the platform key, which is also how
 * api/billing/charge.ts reads key ownership back off the stored payload.
 */
export function keyBinding(resolved: ResolvedModel): Record<string, unknown> {
  return resolved.byok === null ? {} : { ssmParamName: resolved.byok.ssmParamName };
}
