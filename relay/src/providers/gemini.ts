// relay/src/providers/gemini.ts
//
// The ONLY file in the relay that knows Gemini exists.
//
// Ported from poc/lib/providers/gemini.ts, which was itself shaped after the
// production adapter in smartstocke/api/relay/relay-handler.ts. Same
// generateContent call, same inlineData part, same `responseMimeType:
// "application/json"` applied by US and not by the caller, same
// permanent/transient split on the HTTP status, same usage accounting including
// `thoughtsTokenCount`.
//
// Three details carried over verbatim because getting them wrong costs money:
//
//  1. `thoughtsTokenCount` is BILLED AT THE OUTPUT RATE and cannot be disabled
//     on Gemini 3.x. Omitting it under-bills every single call.
//  2. A 4xx that is not a 429 will fail identically however often it runs, so
//     it is answered, not retried.
//  3. A 200 with no text is a safety block or an empty generation, which
//     repeats on the same input — also permanent.
//
// The only thing this port ADDS is the hosted-document branch: in the POC the
// document was a local path, here it arrives either as bytes the channel read
// out of S3 or as a Files API id (§4, §12.3).

import { GoogleGenAI } from "@google/genai";
import { PermanentError } from "../errors";
import type { AdapterRequest, AiAdapter, AiResult } from "./types";

export const PROVIDER = "gemini";

/**
 * Provider-neutral JSON Schema → Gemini's OpenAPI-subset dialect.
 *
 * Gemini rejects `additionalProperties` and does not accept a
 * `["string","null"]` type union; optionality is `nullable: true`. The frozen
 * field list stays the single source of truth and each adapter owns its own
 * translation — which is precisely why the field list is DATA and not a
 * hand-written schema (§3.1).
 */
export function toGeminiSchema(node: Record<string, unknown>): Record<string, unknown> {
  const rawType: unknown = node["type"];
  const union: unknown[] | undefined = Array.isArray(rawType) ? (rawType as unknown[]) : undefined;
  const nullable = union?.includes("null") === true;
  const type = union === undefined ? rawType : union.find((t) => t !== "null");

  const out: Record<string, unknown> = { type };
  if (typeof node["description"] === "string") out["description"] = node["description"];
  if (nullable) out["nullable"] = true;
  // §12.13 — the verify hop's output schema constrains `verdict` to a closed
  // set (confirmado/refutado/ilegivel). Gemini's OpenAPI-subset dialect accepts
  // `enum` on a string property; nothing before that hop needed it.
  if (Array.isArray(node["enum"])) out["enum"] = node["enum"];

  if (type === "object") {
    const props = (node["properties"] ?? {}) as Record<string, Record<string, unknown>>;
    const mapped: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) mapped[k] = toGeminiSchema(v);
    out["properties"] = mapped;
    // propertyOrdering preserves the FIELD LIST ORDER (§3.1, "ordered") in the
    // model's output, which keeps diffs between two extractions readable.
    out["propertyOrdering"] = Object.keys(props);
    const required = (node["required"] ?? []) as string[];
    const requiredHere = required.filter((k) => {
      // A nullable field must NOT be required: Gemini reads `required` as
      // "present and non-null", so requiring one turns every document that
      // legitimately omits it into an error instead of a null.
      const fieldType: unknown = props[k]?.["type"];
      return fieldType !== undefined && !Array.isArray(fieldType);
    });
    if (requiredHere.length > 0) out["required"] = requiredHere;
  }

  if (type === "array" && node["items"] !== undefined) {
    out["items"] = toGeminiSchema(node["items"] as Record<string, unknown>);
  }

  return out;
}

/**
 * One SDK client per API key, for the life of the container.
 *
 * Keyed by the key itself rather than by tenant: under BYOK two tenants can be
 * pointed at the same key and one tenant's key can be rotated, and in both
 * cases the KEY is the thing that identifies the connection. Rotation is
 * handled by the SSM cache above this — a rotated key is a different string, so
 * it lands on a different entry rather than reusing a client authenticated with
 * the old one.
 */
const clients = new Map<string, GoogleGenAI>();

function clientFor(apiKey: string): GoogleGenAI {
  const existing = clients.get(apiKey);
  if (existing !== undefined) {
    return existing;
  }
  const created = new GoogleGenAI({ apiKey });
  clients.set(apiKey, created);
  return created;
}

/** Exported for tests: a warm container legitimately never constructs a client,
 * so a test asserting on construction has to be able to say "cold". */
export function resetClientCache(): void {
  clients.clear();
}

function buildParts(req: AdapterRequest): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [{ text: req.prompt }];
  const doc = req.document;
  if (doc === undefined) {
    return parts;
  }
  if (doc.kind === "inline") {
    parts.push({ inlineData: { mimeType: doc.mimeType, data: doc.data } });
  } else {
    // Files API handle. §12.3: this id is only meaningful under the same
    // provider and the same key owner, both already re-checked in job.ts.
    parts.push({ fileData: { mimeType: doc.mimeType, fileUri: doc.fileId } });
  }
  return parts;
}

function buildConfig(req: AdapterRequest): Record<string, unknown> {
  const config: Record<string, unknown> = {
    systemInstruction: req.system,
    maxOutputTokens: req.maxTokens,
    // Extraction is arithmetic, not prose. Sampling is what turns a correct
    // reading into a plausible one.
    temperature: 0,
  };
  if (req.schema !== undefined) {
    // Ours, not the caller's: it is what makes the answer parseable at all, so
    // it cannot be overridden from the job payload.
    config["responseMimeType"] = "application/json";
    config["responseSchema"] = toGeminiSchema(req.schema);
  }
  return config;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  if (typeof record["status"] === "number") return record["status"];
  const message = typeof record["message"] === "string" ? record["message"] : "";
  const m = /\b(4\d{2}|5\d{2})\b/u.exec(message);
  return m?.[1] === undefined ? undefined : Number.parseInt(m[1], 10);
}

function describe(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 400);
}

export const geminiAdapter: AiAdapter = {
  provider: PROVIDER,
  send: async (req: AdapterRequest, apiKey: string): Promise<AiResult> => {
    const client = clientFor(apiKey);

    let response;
    try {
      response = await client.models.generateContent({
        model: req.model,
        contents: [{ role: "user", parts: buildParts(req) }],
        config: buildConfig(req),
      });
    } catch (error) {
      const status = statusOf(error);
      // 429 and 5xx fall through to the transient default. A network failure
      // never reached Gemini, so nothing was billed and nothing was decided —
      // also transient, and left unclassified on purpose.
      if (status !== undefined && status !== 429 && status >= 400 && status < 500) {
        throw new PermanentError(`gemini ${String(status)}: ${describe(error)}`);
      }
      throw error;
    }

    const text = response.text;
    if (text === undefined || text.length === 0) {
      throw new PermanentError("gemini returned no text (safety block or empty generation)");
    }

    const usage = response.usageMetadata;
    // Canonical usage feeds billing: a success without usage metadata must not
    // become a zero-cost row. Fail the job instead of silently underbilling.
    if (usage?.promptTokenCount === undefined || usage.candidatesTokenCount === undefined) {
      throw new PermanentError("gemini returned content without usage metadata — refusing to bill zero");
    }
    return {
      content: text,
      usage: {
        input_tokens: usage.promptTokenCount,
        // Thinking tokens are charged at the OUTPUT rate and cannot be turned
        // off on Gemini 3.x, so omitting them under-bills every call.
        output_tokens: usage.candidatesTokenCount + (usage.thoughtsTokenCount ?? 0),
      },
      model: req.model,
      provider: PROVIDER,
    };
  },
};
