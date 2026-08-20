/**
 * Gemini adapter. The ONLY file in the POC that knows this provider exists.
 *
 * Shaped after the production relay adapter in
 * `smartstocke/api/relay/relay-handler.ts` — same generateContent call, same
 * inlineData part, same `responseMimeType: "application/json"` applied by US and
 * not by the caller, same permanent/transient split on the HTTP status, and the
 * same usage accounting including `thoughtsTokenCount`.
 *
 * Two details carried over verbatim because getting them wrong costs money:
 *
 *  1. `thoughtsTokenCount` is BILLED AT THE OUTPUT RATE and cannot be disabled
 *     on Gemini 3.x. Omitting it under-bills every single call.
 *  2. A 4xx that is not a 429 will fail identically however often it runs, so it
 *     is answered, not retried.
 */
import { GoogleGenAI } from "@google/genai";
import { readFileSync } from "node:fs";
import type { AiAdapter, AiJob, AiResult } from "./types.ts";
import { PermanentError } from "./types.ts";

/**
 * Provider-neutral JSON Schema -> Gemini's OpenAPI-subset dialect.
 *
 * Gemini rejects `additionalProperties` and does not accept a `["string","null"]`
 * type union; optionality is `nullable: true`. The frozen field list stays the
 * single source of truth and each adapter owns its own translation — which is
 * precisely why the field list is DATA and not a hand-written schema (§3.1).
 */
function toGeminiSchema(node: Record<string, unknown>): Record<string, unknown> {
  const rawType = node["type"];
  const nullable = Array.isArray(rawType) && rawType.includes("null");
  const type = Array.isArray(rawType) ? rawType.find((t) => t !== "null") : rawType;

  const out: Record<string, unknown> = { type };
  if (typeof node["description"] === "string") out["description"] = node["description"];
  if (nullable) out["nullable"] = true;

  if (type === "object") {
    const props = (node["properties"] ?? {}) as Record<string, Record<string, unknown>>;
    const mapped: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) mapped[k] = toGeminiSchema(v);
    out["properties"] = mapped;
    // propertyOrdering preserves the FIELD LIST ORDER (§3.1, "ordered") in the
    // model's output, which keeps diffs between two extractions readable.
    out["propertyOrdering"] = Object.keys(props);
    const required = (node["required"] ?? []) as string[];
    const requiredHere = required.filter((k) => props[k]?.["type"] !== undefined && !Array.isArray(props[k]?.["type"]));
    if (requiredHere.length > 0) out["required"] = requiredHere;
  }

  if (type === "array" && node["items"] !== undefined) {
    out["items"] = toGeminiSchema(node["items"] as Record<string, unknown>);
  }

  return out;
}

export function createGeminiAdapter(apiKey: string): AiAdapter {
  const client = new GoogleGenAI({ apiKey });

  return {
    provider: "gemini",
    send: async (job: AiJob, model: string): Promise<AiResult> => {
      const parts: Record<string, unknown>[] = [{ text: job.prompt }];
      if (job.documentPath !== undefined) {
        parts.push({
          inlineData: {
            mimeType: "application/pdf",
            data: readFileSync(job.documentPath).toString("base64"),
          },
        });
      }

      let response;
      try {
        response = await client.models.generateContent({
          model,
          contents: [{ role: "user", parts }],
          config: {
            systemInstruction: job.system,
            maxOutputTokens: job.maxTokens,
            temperature: 0,
            // Ours, not the caller's: it is what makes the answer parseable at
            // all, so it cannot be overridden from the job payload.
            responseMimeType: "application/json",
            responseSchema: toGeminiSchema(job.schema),
          },
        });
      } catch (error) {
        const status = extractStatus(error);
        if (status !== undefined && status !== 429 && status >= 400 && status < 500) {
          throw new PermanentError(`gemini ${String(status)}: ${describe(error)}`);
        }
        throw error;
      }

      const text = response.text;
      if (text === undefined || text.length === 0) {
        // A 200 with no candidate is a safety block or an empty generation,
        // which repeats on the same input. Answering beats retrying.
        throw new PermanentError("gemini devolveu resposta sem texto");
      }

      const usage = response.usageMetadata;
      return {
        text,
        usage: {
          input_tokens: usage?.promptTokenCount ?? 0,
          // Thinking tokens are charged at the OUTPUT rate and cannot be turned
          // off on Gemini 3.x, so omitting them under-bills every call.
          output_tokens: (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
        },
        model,
        provider: "gemini",
      };
    },
  };
}

function extractStatus(error: unknown): number | undefined {
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
