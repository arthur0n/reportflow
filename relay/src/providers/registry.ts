// relay/src/providers/registry.ts
//
// The whole registry (decisions §6). One line per provider; nothing above this
// file names one.
//
// Adding Anthropic or OpenAI is: one file in this directory implementing
// `AiAdapter`, one line in ADAPTERS, one SSM parameter
// (`/reportflow/relay/{env}/{provider}-api-key`). No IAM change — the policy is
// already a prefix — no change to the API, the schema, or the frontend. That is
// the property §6 exists to buy, and it is only real while this file stays a
// lookup table rather than growing branches.
//
// There is no default provider. The job names one, because §6 makes the
// provider a per-account and per-hop decision and a default here would be a
// fourth place that decides it.

import { PermanentError } from "../errors";
import { geminiAdapter } from "./gemini";
import type { AiAdapter } from "./types";

/**
 * A Map, not an object literal, because `provider` comes off a job payload and
 * an object lookup answers for keys nobody registered: `ADAPTERS["__proto__"]`
 * is Object.prototype and `ADAPTERS["constructor"]` is a function, so a plain
 * record would hand `getAdapter` something truthy that is not an adapter and
 * the failure would surface as a TypeError deep inside the channel.
 */
const ADAPTERS: ReadonlyMap<string, AiAdapter> = new Map([[geminiAdapter.provider, geminiAdapter]]);

/** Provider ids this relay can serve, for error messages and tests. */
export function knownProviders(): string[] {
  return [...ADAPTERS.keys()].sort();
}

/**
 * An unknown provider is PERMANENT: the deployed bundle is the set of adapters
 * that exist, so the same job will fail identically until someone ships a new
 * one. Retrying it would spend the collector's attempts to re-learn a fact that
 * cannot change between them.
 */
export function getAdapter(provider: string): AiAdapter {
  const adapter = ADAPTERS.get(provider);
  if (adapter === undefined) {
    throw new PermanentError(
      `unknown provider: ${provider} (known: ${knownProviders().join(", ")})`,
    );
  }
  return adapter;
}
