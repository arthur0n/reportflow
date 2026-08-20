// api/billing/cost-of-goods.ts
//
// PORTED VERBATIM from smartstocke/api/billing/cost-of-goods.ts (decisions
// §7, §11). The arithmetic, the fail-open in `costFor`, the fail-CLOSED in
// `isPricedModel`, and every rate row are the sibling project's — the only
// additions are the PROVIDER argument (§12.6: "model names are not globally
// unique across providers") and this header.
//
// WHY `costFor` TAKES A PROVIDER AND THE TABLE STILL DOES NOT KEY ON ONE.
// smartstocke bills one provider and keys the table on the model id alone.
// ReportFlow's charge idempotency includes the provider because two providers
// may one day ship the same model name, and a table keyed only on the name
// would price the wrong one silently. So the KEY is `{provider}/{model}` and
// the lookup falls back to the bare model id for the rows carried over
// verbatim — a bare row is a row nobody has had to disambiguate yet.
//
// Tabela de custo dos provedores de IA — centavos de USD por 1M de tokens,
// separando input e output.
//
// ATENÇÃO: taxas mudam — confirmar contra a página de preços do provedor ao
// adicionar/atualizar um modelo. Última revisão herdada: 2026-07.

export interface TokenUsage {
  readonly input_tokens: number;
  readonly output_tokens: number;
}

export interface ModelRate {
  readonly input_cents_per_1m: number;
  readonly output_cents_per_1m: number;
}

const RATE_UNIT = 1_000_000;

/**
 * The rate card. Keys are bare model ids (carried over verbatim from
 * smartstocke) or `{provider}/{model}` when a name needs disambiguating.
 *
 * NOTHING HERE IS INVENTED. decisions §10.5 is explicit that the table prices
 * Gemini and OpenAI only and that `isPricedModel()` "will refuse to bill until
 * [the missing rows] exist, which is the intended fail-closed behaviour".
 * Adding a row you guessed converts a loud refusal into a silent wrong invoice,
 * which is strictly worse than the refusal.
 *
 * TODO(pricing): two rows are KNOWN MISSING and both are deliberate:
 *
 *   1. `gemini-3.1-pro-preview` — the §12.13 verifier's platform default
 *      (poc/lib/ai.ts `MODEL_VERIFY`). poc/lib/ai.ts carries
 *      `{ input: 350, output: 1750 }` and says so in its own comment:
 *      "estimated from the same flash/flash-lite ratio (~2x flash) pending a
 *      real rate card entry". An ESTIMATE is not a rate card, and this file is
 *      what the customer is invoiced from. Until a real rate is confirmed,
 *      `resolveModel(…, "verify")` REFUSES to start a platform-key verify hop
 *      (api/services/credentials-service.ts) — no money is spent and no zero
 *      charge is written. BYOK tenants verify today, because BYOK bills 0 by
 *      definition and the rate card is irrelevant to them (§7).
 *      The fix is one line here, confirmed against Google's price page.
 *
 *   2. Anthropic rows (§10.5). smartstocke has none — checked; its
 *      COST_OF_GOODS is Gemini + `gpt-4o-mini` and nothing else — so there is
 *      nothing authoritative to port. They land the day an Anthropic key is
 *      configured, together with the relay adapter that would need one.
 */
export const COST_OF_GOODS: Readonly<Record<string, ModelRate>> = {
  // Gemini 3.x (geração atual, 2026-08) — imagem entra como input tokens.
  "gemini-3.5-flash-lite": { input_cents_per_1m: 30, output_cents_per_1m: 250 },
  "gemini-3.1-flash-lite": { input_cents_per_1m: 25, output_cents_per_1m: 150 },
  "gemini-3.5-flash": { input_cents_per_1m: 150, output_cents_per_1m: 900 },
  // Legado 2.5 (em descontinuação — manter enquanto houver cobrança antiga).
  "gemini-2.5-flash": { input_cents_per_1m: 30, output_cents_per_1m: 250 },
  // OpenAI mini-tier.
  "gpt-4o-mini": { input_cents_per_1m: 15, output_cents_per_1m: 60 },
};

function safeAmount(amount: number): number {
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

/** `{provider}/{model}` first, bare `{model}` second. See the header. */
function rateFor(provider: string, model: string): ModelRate | undefined {
  return COST_OF_GOODS[`${provider}/${model}`] ?? COST_OF_GOODS[model];
}

/**
 * Centavos de USD FRACIONÁRIOS (numeric(12,4) no banco).
 *
 * FAIL-OPEN, and that is correct FOR THIS FUNCTION: a missing rate row must
 * never break a hop that already ran. It is `isPricedModel` below — asked
 * FIRST, by the caller — that refuses to persist a charge it cannot price.
 */
export function costFor(provider: string, model: string, usage: TokenUsage): number {
  const rate = rateFor(provider, model);
  if (rate === undefined) return 0;
  const inputCost = (safeAmount(usage.input_tokens) * rate.input_cents_per_1m) / RATE_UNIT;
  const outputCost = (safeAmount(usage.output_tokens) * rate.output_cents_per_1m) / RATE_UNIT;
  return inputCost + outputCost;
}

/**
 * ADDED IN THE PORT by smartstocke, kept here for the same reason it exists
 * there.
 *
 * The fail-open above is right for the function it serves and WRONG as the
 * last word on billing: an unknown model silently costs zero, so a model
 * nobody priced is a model nobody is charged for. UNPRICED IS NOT FREE.
 *
 * So the platform-key path asks this question FIRST and refuses rather than
 * writing a zero. The fix for a refusal is one line in COST_OF_GOODS, which is
 * the point: it should cost someone a deploy, not cost the business the
 * revenue.
 */
export function isPricedModel(provider: string, model: string): boolean {
  return rateFor(provider, model) !== undefined;
}
