// api/collector/relay-result.ts
//
// Reading `results/{tenantId}/{jobId}.json` without trusting it (§12.4).
//
// The relay writes either the canonical adapter result verbatim
// (`{content, usage, model, provider}`, relay/src/providers/types.ts) or a
// classified failure (`{error:{type,message}}`, relay/src/relay-handler.ts).
// Two bundles, no shared import, so this is the API-side statement of that
// contract and api/collector/relay-result.test.ts is what keeps the two honest.
//
// THE VALIDATION HERE IS STRUCTURAL, and it is the FIRST of two. This file
// answers one question about the ENVELOPE — a usable answer, an answer-shaped
// thing that is not usable, or an explicit failure — and everything downstream
// forks on exactly that. The second question, "is the extraction valid against
// the frozen field list", is §4.2's own fork and lives in
// shared/validation/extraction-validation.ts, called from collect.ts because
// that is where the one retry §4.2 allows is spent. Keeping them apart is what
// lets a `detect` or `analyse` result run through this file without dragging a
// field list it has no use for.

/** A usable answer. `content` is raw model text — still unparsed, still
 * untrusted; `parseModelJson` is the next step and it can also fail. */
export interface RelaySuccess {
  readonly kind: "success";
  readonly content: string;
  readonly provider: string;
  readonly model: string;
  /**
   * The canonical usage envelope (relay/src/providers/types.ts `AiUsage`) —
   * what §7 bills on, and the reason `costFor()` works across providers
   * unchanged.
   *
   * Carried as `unknown` rather than a typed pair on purpose: a provider that
   * reports cache-read or thinking tokens we do not model yet must survive the
   * trip into `ai_charges.usage` (jsonb, for exactly this reason — see
   * drizzle/tables/billing.ts). api/billing/charge.ts `readUsage` narrows the
   * two counts it needs and leaves the rest intact.
   *
   * NOT part of the "is this a usable answer" test. A relay that wrote a
   * result with a malformed usage block still answered the question the hop
   * asked, and throwing away a paid extraction over a billing field would be
   * the wrong trade in both directions.
   */
  readonly usage: unknown;
}

/** A failure, classified by the relay (relay/src/errors.ts). `permanent` means
 * another attempt only spends money to reach the same conclusion. */
export interface RelayFailure {
  readonly kind: "failure";
  readonly type: "permanent" | "transient";
  readonly message: string;
}

export type ParsedRelayResult = RelaySuccess | RelayFailure;

/** Bounded the same way the relay bounds its own error text: a provider's
 * multi-kilobyte body must not become a `report_jobs.error` column. */
const MAX_MESSAGE = 400;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Envelope → one of three verdicts.
 *
 * An UNRECOGNISED envelope is reported as a TRANSIENT failure, not a permanent
 * one, for the reason relay/src/errors.ts gives for the same default: the two
 * mistakes are not symmetric. Calling it permanent throws away a report the
 * user is waiting for because of a shape we failed to anticipate; calling it
 * transient costs one extra hop and then lands in `revisar`, where a human sees
 * it. The retry ceiling (§4.2) bounds the cost either way.
 */
export function parseRelayResult(raw: unknown): ParsedRelayResult {
  const envelope = asRecord(raw);
  if (envelope === null) {
    return { kind: "failure", type: "transient", message: "relay result is not a JSON object" };
  }

  const error = asRecord(envelope["error"]);
  if (error !== null) {
    const type = error["type"] === "permanent" ? "permanent" : "transient";
    const message = asString(error["message"]) ?? "relay reported a failure with no message";
    return { kind: "failure", type, message: message.slice(0, MAX_MESSAGE) };
  }

  const content = asString(envelope["content"]);
  const provider = asString(envelope["provider"]);
  const model = asString(envelope["model"]);
  if (content === null || provider === null || model === null) {
    return {
      kind: "failure",
      type: "transient",
      message: "relay result is neither a canonical success nor a classified error",
    };
  }
  return { kind: "success", content, provider, model, usage: envelope["usage"] };
}

/**
 * A body that could not be read at all, expressed as an envelope so it takes
 * THE SAME path as every other failure (api/collector/collect.ts).
 *
 * Both ingress paths build this rather than each deciding what an unreadable
 * result means — a second opinion on that is a second idempotency, which §4.1
 * spends a whole paragraph forbidding.
 *
 * PERMANENT, deliberately, and this is the one place the "unrecognised is
 * transient" default above does not apply. The relay writes a result with a
 * single conditional PutObject, so S3 never serves a torn one: a body that is
 * not JSON, or is over the cap, is a body the relay WROTE that way, and no
 * amount of re-running the provider changes what is already sitting in the
 * bucket. Retrying would spend ~$0.28 to reach the same conclusion — which is
 * exactly what relay/src/errors.ts defines `permanent` to mean. It lands in
 * `revisar` for an extraction (a human can see it) and `failed` otherwise.
 */
export function malformedResultEnvelope(reason: string): Record<string, unknown> {
  return { error: { type: "permanent", message: `resultado ilegível: ${reason}` } };
}

export type ModelJson =
  | { readonly ok: true; readonly data: Record<string, unknown> }
  | { readonly ok: false; readonly message: string };

/**
 * The model's own JSON, one level of trust further in.
 *
 * A hop that asked for structured output and got back prose, a truncated
 * object, or a bare array is the exact case §4.2 calls "most schema violations
 * are transient" — so this failing is a RETRYABLE outcome, not a crash. An
 * array is refused alongside a non-object because every consumer of
 * `extractions.data` addresses it by field name (§3.2 `{{nota.titular.nome}}`),
 * and an array would satisfy `typeof === "object"` while satisfying nothing
 * else.
 */
export function parseModelJson(content: string): ModelJson {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `model output is not JSON: ${detail}`.slice(0, MAX_MESSAGE) };
  }
  const data = asRecord(raw);
  if (data === null) {
    return { ok: false, message: "model output is not a JSON object" };
  }
  return { ok: true, data };
}
