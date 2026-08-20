/**
 * The registry (§6). One line per provider; nothing above this file names one.
 *
 * `costFor()` works unchanged across providers because `usage` is canonical.
 * Rates are ported from `smartstocke/api/billing/cost-of-goods.ts` — and so is
 * the rule that matters: UNPRICED IS NOT FREE. A model missing from the table
 * throws instead of billing zero (§7, §10.5).
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createGeminiAdapter } from "./providers/gemini.ts";
import type { AiAdapter, AiJob, AiResult } from "./providers/types.ts";
import { PermanentError } from "./providers/types.ts";

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

/**
 * §6, "model scope": separately settable per hop. Extraction is accuracy-
 * critical, analysis is prose. Both ids are pinned from the sibling project's
 * live pricing table rather than invented here.
 */
export const MODEL_EXTRACT = "gemini-3.5-flash";
export const MODEL_ANALYSE = "gemini-3.5-flash-lite";

/** cents of USD per 1M tokens — copied from smartstocke's COST_OF_GOODS. */
const COST_OF_GOODS: Readonly<Record<string, { input: number; output: number }>> = {
  "gemini-3.5-flash": { input: 150, output: 900 },
  "gemini-3.5-flash-lite": { input: 30, output: 250 },
  "gemini-3.1-flash-lite": { input: 25, output: 150 },
  "gemini-2.5-flash": { input: 30, output: 250 },
};

export function isPricedModel(model: string): boolean {
  return model in COST_OF_GOODS;
}

/** USD for one call. Throws on an unpriced model — fail-closed, by design. */
export function costUsd(model: string, usage: AiResult["usage"]): number {
  const rate = COST_OF_GOODS[model];
  if (rate === undefined) throw new Error(`modelo sem preço na tabela: ${model} — "unpriced is not free" (§7)`);
  return ((usage.input_tokens / 1_000_000) * rate.input + (usage.output_tokens / 1_000_000) * rate.output) / 100;
}

/* ------------------------------------------------------------------ */

/** .env is not committed; read it without pulling in a dotenv dependency. */
export function readEnvKey(name: string): string | null {
  const fromEnv = process.env[name];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;

  const envFile = resolve(REPO_ROOT, ".env");
  if (!existsSync(envFile)) return null;
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)\\s*$`, "u").exec(line);
    if (m) {
      const raw = (m[1] ?? "").trim().replace(/^["']|["']$/gu, "");
      if (raw.length > 0) return raw;
    }
  }
  return null;
}

/** The whole registry. Adding a provider is one entry. */
export function getAdapter(): AiAdapter | null {
  const googleKey = readEnvKey("GOOGLE_API_KEY");
  if (googleKey !== null) return createGeminiAdapter(googleKey);
  return null;
}

/* ------------------------------------------------------------------ */

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Transient-only retry. A PermanentError (4xx that is not a throttle, safety
 * block, empty generation) is answered immediately — retrying it burns money to
 * reach the same conclusion.
 */
export async function callWithRetry(adapter: AiAdapter, job: AiJob, model: string, attempt = 1): Promise<AiResult> {
  try {
    return await adapter.send(job, model);
  } catch (error) {
    if (error instanceof PermanentError || attempt >= 4) throw error;
    const backoffMs = 2000 * 2 ** (attempt - 1);
    const reason = error instanceof Error ? error.message.slice(0, 120) : String(error);
    console.warn(`  ! falha transitória (${reason}) — nova tentativa em ${String(backoffMs / 1000)}s [${String(attempt)}/3]`);
    await sleep(backoffMs);
    return callWithRetry(adapter, job, model, attempt + 1);
  }
}

export type { AiAdapter, AiJob, AiResult } from "./providers/types.ts";
