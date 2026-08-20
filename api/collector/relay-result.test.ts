// api/collector/relay-result.test.ts
//
// The API-side statement of the relay's result contract. The relay writes these
// envelopes from a different bundle that this one cannot import
// (relay/src/providers/types.ts, relay/src/relay-handler.ts), so the literals
// below are duplicated ON PURPOSE — the point is that two independently
// compiled halves still agree on the shape.

import { describe, it, expect } from "vitest";
import { malformedResultEnvelope, parseModelJson, parseRelayResult } from "./relay-result";

/** Byte-for-byte the canonical adapter result (§6). */
const SUCCESS = {
  content: '{"total":10}',
  usage: { input_tokens: 100, output_tokens: 20 },
  model: "gemini-2.5-pro",
  provider: "gemini",
};

describe("parseRelayResult", () => {
  it("reads the canonical success envelope", () => {
    expect(parseRelayResult(SUCCESS)).toEqual({
      kind: "success",
      content: '{"total":10}',
      provider: "gemini",
      model: "gemini-2.5-pro",
      // §7 bills on this, so it has to survive the parse. Carried through
      // UNNARROWED — a provider that reports cache-read or thinking tokens we
      // do not model yet must still reach `ai_charges.usage` intact.
      usage: { input_tokens: 100, output_tokens: 20 },
    });
  });

  // A malformed usage block is a fact about BILLING, not about whether the hop
  // answered. Throwing away a paid extraction over it would be the wrong trade
  // in both directions; api/billing/charge.ts `readUsage` narrows it to zeros.
  it("still reads a success whose usage block is missing", () => {
    const { usage, ...withoutUsage } = SUCCESS;
    void usage;
    expect(parseRelayResult(withoutUsage)).toMatchObject({ kind: "success", usage: undefined });
  });

  it("reads a classified failure and keeps the classification", () => {
    expect(parseRelayResult({ error: { type: "permanent", message: "unknown provider" } })).toEqual(
      {
        kind: "failure",
        type: "permanent",
        message: "unknown provider",
      },
    );
    expect(parseRelayResult({ error: { type: "transient", message: "429" } })).toMatchObject({
      kind: "failure",
      type: "transient",
    });
  });

  // relay/src/errors.ts defaults to transient for the same reason: the two
  // mistakes are not symmetric. A wrong "permanent" throws away a report.
  it("treats an unrecognised error type as transient", () => {
    expect(parseRelayResult({ error: { type: "weird", message: "x" } })).toMatchObject({
      type: "transient",
    });
  });

  it("treats an unrecognised envelope as a transient failure, not a success", () => {
    for (const raw of [null, 42, "ready", [], {}, { content: "" }, { content: "x" }]) {
      expect(parseRelayResult(raw).kind).toBe("failure");
    }
  });

  // Catches: accepting a success without provider/model, which would then be
  // written into `extractions` as NULL and make the row unattributable.
  it("refuses a success that is missing its provenance", () => {
    expect(parseRelayResult({ content: "x", provider: "gemini" }).kind).toBe("failure");
    expect(parseRelayResult({ content: "x", model: "m" }).kind).toBe("failure");
  });

  it("bounds the error message so a provider body cannot become the column", () => {
    const parsed = parseRelayResult({ error: { type: "transient", message: "x".repeat(5000) } });
    expect(parsed.kind === "failure" && parsed.message.length).toBe(400);
  });
});

// The bridge for defect 1: an unreadable body becomes an envelope, so it takes
// THE SAME failure path as everything else rather than a second one invented at
// each ingress.
describe("malformedResultEnvelope", () => {
  it("round-trips through parseRelayResult as a permanent failure", () => {
    const parsed = parseRelayResult(malformedResultEnvelope("corpo não é JSON"));
    expect(parsed).toMatchObject({ kind: "failure", type: "permanent" });
    expect(parsed.kind === "failure" && parsed.message).toContain("corpo não é JSON");
  });

  // Permanent, not transient: the relay writes a result with one conditional
  // PutObject, so S3 never serves a torn one — a body that will not parse is a
  // body the relay wrote that way, and no re-run changes what is in the bucket.
  it("does not invite a paid retry", () => {
    const parsed = parseRelayResult(malformedResultEnvelope("qualquer"));
    expect(parsed.kind === "failure" && parsed.type).not.toBe("transient");
  });
});

describe("parseModelJson", () => {
  it("accepts a JSON object", () => {
    expect(parseModelJson('{"a":1}')).toEqual({ ok: true, data: { a: 1 } });
  });

  // §4.2 — "most schema violations are transient". The caller turns each of
  // these into the retry-once path, not into a crash.
  it("refuses prose, a truncated object, and a bare scalar", () => {
    expect(parseModelJson("Claro! Aqui está:").ok).toBe(false);
    expect(parseModelJson('{"a":').ok).toBe(false);
    expect(parseModelJson("7").ok).toBe(false);
  });

  // Every consumer addresses extraction data by field name (§3.2), so an array
  // satisfies `typeof === "object"` and nothing else.
  it("refuses a bare array", () => {
    expect(parseModelJson("[1,2,3]").ok).toBe(false);
  });
});
