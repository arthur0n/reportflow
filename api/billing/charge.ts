// api/billing/charge.ts
//
// THE LEDGER WRITE (decisions §7, §12.6). One function writes `ai_charges`,
// and every hop reaches it through the collector — because the collector is
// the one place that knows a hop actually RAN and what it cost.
//
// THE FORK IS KEY OWNERSHIP, NOT MODEL, NOT HOP (§7):
//
//   platform key (ai_credentials.ssm_param_name IS NULL)
//     → raw  = costFor(provider, model, usage)
//     → owed = raw × credit_config['mult.<source>']   (frozen at write time)
//     → isPricedModel() ENFORCED — "unpriced is not free"
//
//   BYOK (ssm_param_name SET)
//     → raw = 0, owed = 0, ANY model allowed, pricing table irrelevant
//     → THE ROW IS STILL WRITTEN. It is the usage record, and `ref_id UNIQUE`
//       is the same idempotency either way — a BYOK tenant who later moves to
//       the platform key must not re-bill artifacts they already produced.
//
// `ref_id` IS THE WHOLE IDEMPOTENCY STORY under the collector's at-least-once
// delivery, and it keys on the ARTIFACT, not the job: re-reading the same PDF
// must not bill twice, which is exactly what a user does when a read looks
// wrong. It carries the PROVIDER (§12.6) because model names are not globally
// unique across providers.
//
// WHERE THE FACTS COME FROM, and why they come from where they do:
//
//   provider / model / usage  ← the RESULT. What actually ran and what it
//                               actually cost. The job payload says what was
//                               ASKED for; a relay that fell back, or a
//                               provider that served a dated alias, makes
//                               those two different facts and only one of them
//                               is billable.
//   source / refKey / byok    ← the stored `report_jobs.request`. The artifact
//                               identity was decided when the job was built
//                               and cannot be recovered from the answer.
//
// The BYOK flag is read as `ssmParamName !== undefined` on that same payload —
// the very field the relay reads to decide whose key to fetch
// (relay/src/job.ts `keyOwnerOf`). One fact, one field, no second flag to
// disagree with it.

import { eq } from "drizzle-orm";
import { aiCharges, creditConfig } from "../../drizzle/schema";
import type { DbLike } from "../collector/job-state";
import { costFor, isPricedModel, type TokenUsage } from "./cost-of-goods";
import { applyMultiplier, MULT_DEFAULT_X100 } from "./money";

/** Which hop spent the credit. Mirrors the vocabulary in
 * drizzle/tables/billing.ts's `ai_charges.source` comment. */
export const CHARGE_SOURCES = ["detect", "extract", "analyse", "verify"] as const;
export type ChargeSource = (typeof CHARGE_SOURCES)[number];

/**
 * §12.6's `ref_id` prefixes, verbatim. `report_detect` is the one this design
 * did not name — detection is a hop like any other and a hop that is not
 * billed is a hop nobody pays for — and it follows the identical grammar.
 */
const REF_PREFIX: Readonly<Record<ChargeSource, string>> = {
  detect: "report_detect",
  extract: "report_extraction",
  analyse: "report_analysis",
  verify: "report_verify",
};

/** `mult.<source>` in `credit_config` (§7, §8). */
export function multiplierKey(source: ChargeSource): string {
  return `mult.${source}`;
}

/**
 * `{prefix}:{provider}:{model}:{refKey}` — §12.6, one composer.
 *
 * The hop-specific half (`refKey`) is minted by whichever module builds the
 * job, because that is the ONE place that knows which artifact the job is
 * about. This function knows only the grammar.
 */
export function chargeRefId(
  source: ChargeSource,
  provider: string,
  model: string,
  refKey: string,
): string {
  return `${REF_PREFIX[source]}:${provider}:${model}:${refKey}`;
}

// ---------------------------------------------------------------------------
// The billing binding — the half of a charge that only the job builder knows
// ---------------------------------------------------------------------------

/** The payload key the binding rides on, alongside `extractTemplate` and
 * `purpose`. The relay drops it: `parseJob` reconstructs an `AiJob` from the
 * keys it knows (relay/src/job.ts) and every extra key vanishes for free. */
export const BILLING_KEY = "billing";

export interface BillingBinding {
  readonly source: ChargeSource;
  /** The artifact this hop is about, in the hop's own vocabulary. */
  readonly refKey: string;
}

/** Spread into a job payload by every builder. One shape, one reader. */
export function billingBinding(binding: BillingBinding): Record<string, unknown> {
  return { [BILLING_KEY]: { source: binding.source, refKey: binding.refKey } };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isChargeSource(value: unknown): value is ChargeSource {
  return typeof value === "string" && (CHARGE_SOURCES as readonly string[]).includes(value);
}

/**
 * Pull the binding back out of a stored `report_jobs.request`.
 *
 * `null` for a job enqueued before this existed, or a payload that is not one.
 * The collector WARNS and settles the job anyway rather than wedging it: a row
 * with no binding cannot be billed by anybody, and refusing to settle it would
 * trade an unbilled hop for a job that is pending forever.
 */
export function readBillingBinding(request: unknown): BillingBinding | null {
  const payload = asRecord(request);
  const raw = payload === null ? null : asRecord(payload[BILLING_KEY]);
  if (raw === null) {
    return null;
  }
  const source = raw["source"];
  const refKey = raw["refKey"];
  if (!isChargeSource(source) || typeof refKey !== "string" || refKey.length === 0) {
    return null;
  }
  return { source, refKey };
}

/**
 * Whose key paid, read off the SAME field the relay reads (§7, §12.7).
 *
 * A separate boolean would be a second statement of one fact, and the day the
 * two disagreed the billing one would be the wrong one — a tenant billed for a
 * call made on their own key.
 */
export function readByok(request: unknown): boolean {
  const payload = asRecord(request);
  return typeof payload?.["ssmParamName"] === "string";
}

/** Canonical relay usage (relay/src/providers/types.ts `AiUsage`), read
 * defensively: it came out of an S3 object and a missing count is 0, not NaN. */
export function readUsage(value: unknown): TokenUsage {
  const raw = asRecord(value);
  const input = raw?.["input_tokens"];
  const output = raw?.["output_tokens"];
  return {
    input_tokens: typeof input === "number" && Number.isFinite(input) ? input : 0,
    output_tokens: typeof output === "number" && Number.isFinite(output) ? output : 0,
  };
}

// ---------------------------------------------------------------------------
// The write
// ---------------------------------------------------------------------------

/**
 * A platform-key hop on a model `COST_OF_GOODS` cannot price.
 *
 * Its own class, because the caller's answer is specific: the collector
 * settles the job terminal with an operator-legible message rather than
 * letting a throw leave the row `pending` forever, which is the exact failure
 * the collector exists to prevent (§4.1).
 */
export class UnpricedModelError extends Error {
  public constructor(
    public readonly provider: string,
    public readonly model: string,
  ) {
    super(`no price is configured for ${provider}/${model} — "unpriced is not free" (§7)`);
    this.name = "UnpricedModelError";
  }
}

/**
 * The multiplier, from deployment-wide config.
 *
 * `credit_config` is `global` — no tenant, no user (§8). Falling back to the
 * identity multiplier when the row is absent is smartstocke's behaviour and
 * the right one: a missing config row must not stop a hop, and 1× is the only
 * default that cannot over-charge.
 */
export async function multiplierX100(dbHandle: DbLike, source: ChargeSource): Promise<number> {
  const rows = await dbHandle
    .select({ value: creditConfig.valueInt })
    .from(creditConfig)
    .where(eq(creditConfig.key, multiplierKey(source)))
    .limit(1);
  return rows[0]?.value ?? MULT_DEFAULT_X100;
}

export interface WriteChargeArgs {
  readonly refId: string;
  readonly tenantId: string;
  readonly source: ChargeSource;
  readonly provider: string;
  readonly model: string;
  readonly usage: TokenUsage;
  /** True when `ai_credentials.ssm_param_name` was set for this hop (§7). */
  readonly byok: boolean;
}

export type WriteChargeOutcome =
  /** This call wrote the row. */
  | { readonly written: true }
  /** `ref_id` already existed. The duplicate delivery this design expects. */
  | { readonly written: false };

/**
 * Writes one `ai_charges` row, or discovers it was already written.
 *
 * `ON CONFLICT (ref_id) DO NOTHING` is the entire idempotency: two collectors
 * racing one result, a poll backstop arriving after the Lambda, or a second
 * extraction of the same PDF all converge on one row. Postgres decides, and
 * the loser learns it lost from an empty row set — the same shape as every
 * compare-and-set in api/collector/job-state.ts.
 *
 * `owed_usd_cents` is computed HERE and frozen: changing `credit_config` later
 * must not silently reprice history (§7).
 *
 * `created_by` / `last_upd_by` stay NULL for the same reason the job
 * transitions leave them NULL — no user did this; a machine acting on an S3
 * event did, and inventing an id for it would put a value in an audit column
 * that no audit could resolve.
 */
export async function writeCharge(
  dbHandle: DbLike,
  args: WriteChargeArgs,
): Promise<WriteChargeOutcome> {
  // BYOK: they pay the provider directly. Any model is allowed and the rate
  // card is irrelevant — but the row is still written, because `ref_id` is the
  // same idempotency and this is still a record of a hop that ran.
  const rawCents = args.byok ? 0 : platformRawCents(args);
  const multX100 = args.byok ? 0 : await multiplierX100(dbHandle, args.source);
  const owedCents = args.byok ? 0 : applyMultiplier(rawCents, multX100);

  const rows = await dbHandle
    .insert(aiCharges)
    .values({
      tenantId: args.tenantId,
      source: args.source,
      provider: args.provider,
      model: args.model,
      refId: args.refId,
      usage: args.usage,
      rawUsdCents: String(rawCents),
      multX100,
      owedUsdCents: String(owedCents),
    })
    .onConflictDoNothing({ target: aiCharges.refId })
    .returning({ id: aiCharges.id });

  return rows.length > 0 ? { written: true } : { written: false };
}

/** The platform-key half, with the fail-closed check in front of it. */
function platformRawCents(args: WriteChargeArgs): number {
  if (!isPricedModel(args.provider, args.model)) {
    throw new UnpricedModelError(args.provider, args.model);
  }
  return costFor(args.provider, args.model, args.usage);
}
