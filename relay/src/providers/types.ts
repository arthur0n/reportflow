// relay/src/providers/types.ts
//
// The adapter contract (decisions §6). Ported from poc/lib/providers/types.ts,
// which is where it was proven: that POC survived an Anthropic → Gemini swap
// mid-build and the swap cost exactly one directory — the field lists, the
// templates, the money code and every caller were untouched.
//
// The shape of the bargain:
//
//   canonical job in  →  one adapter file  →  { content, usage, model, provider } out
//
// Nothing above an adapter may name a provider, and no adapter may name a
// ReportFlow concept (a hop, a tenant, a bucket). Adding a provider is one file
// under this directory plus one line in registry.ts plus one SSM parameter —
// the same shape as the relay's CHANNELS registry (relay_lambda.md, "Adding a
// channel").
//
// Two things live in the ADAPTER rather than in the caller, on purpose:
//   * schema translation, because every provider's structured-output dialect is
//     different and the frozen field list must stay the single source of truth
//     (§3.1); and
//   * the permanent/transient decision, because only the adapter can read a
//     provider's own status codes. Everything above it consumes the verdict.

/** Canonical usage. This is what makes `costFor()` work across providers
 * unchanged (§6, §7) — so a provider whose accounting differs must be
 * normalised HERE, not in the billing table. */
export interface AiUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

/**
 * The canonical success result, written verbatim to `results/…json` (§6).
 *
 * `content` is RAW TEXT and is deliberately not parsed here. A model's JSON is
 * untrusted input no matter who called the model (§12.4); the collector
 * validates it against a Zod schema before a byte of it reaches Postgres.
 */
export interface AiResult {
  readonly content: string;
  readonly usage: AiUsage;
  readonly model: string;
  readonly provider: string;
}

/** A document the adapter should attach, already resolved to bytes by the
 * channel. Adapters never touch S3 — that is the channel's job, and keeping it
 * there is what stops each new adapter re-implementing the tenant check. */
export interface InlineDocument {
  readonly kind: "inline";
  readonly mimeType: string;
  /** base64, no data: prefix. */
  readonly data: string;
}

/** A document already uploaded to this provider's own Files API (§4, §12.3).
 * Scoped to (provider, key owner) — job.ts refuses one that arrived on a job
 * for a different provider or a different key owner. */
export interface HostedDocument {
  readonly kind: "hosted";
  readonly mimeType: string;
  readonly fileId: string;
}

export type AdapterDocument = InlineDocument | HostedDocument;

/** Everything an adapter needs, and nothing about where it came from. */
export interface AdapterRequest {
  readonly system: string;
  readonly prompt: string;
  readonly model: string;
  readonly maxTokens: number;
  /** Provider-neutral JSON Schema. Absent for a free-text hop; present, it is
   * the adapter's job to translate it into its own dialect. */
  readonly schema?: Record<string, unknown>;
  /** Absent for hop 2 — §12.3: analysis reads extraction JSON, never the PDF. */
  readonly document?: AdapterDocument;
}

export interface AiAdapter {
  readonly provider: string;
  /**
   * Stateless in the key: the key is an ARGUMENT, not constructor state,
   * because one warm container serves many tenants under BYOK (§7) and an
   * adapter that closed over a key would have to be rebuilt per tenant — or,
   * worse, would quietly serve the previous tenant's key.
   */
  readonly send: (req: AdapterRequest, apiKey: string) => Promise<AiResult>;
}
