// relay/src/providers/gemini.test.ts
//
// The adapter is where a provider swap is supposed to be contained (§6), which
// makes it the one file whose mapping nothing else double-checks. Each case
// below names the broken implementation it catches.
//
// The SDK is mocked. There are no live calls: an adapter test that hits the
// provider tests the provider.

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  generateContent: vi.fn(),
  constructedWith: [] as string[],
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    public readonly models = { generateContent: h.generateContent };
    public constructor(opts: { apiKey: string }) {
      h.constructedWith.push(opts.apiKey);
    }
  },
}));

const { geminiAdapter, toGeminiSchema, resetClientCache } = await import("./gemini");
const { PermanentError } = await import("../errors");

const OK = {
  text: '{"ok":true}',
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 7 },
};

const BASE = { system: "sys", prompt: "hi", model: "gemini-3.5-flash", maxTokens: 4096 } as const;

beforeEach(() => {
  h.generateContent.mockReset();
  h.constructedWith.length = 0;
  resetClientCache();
});

function lastCall(): Record<string, unknown> {
  return h.generateContent.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe("toGeminiSchema", () => {
  // Catches: forwarding the neutral schema verbatim. Gemini rejects a
  // ["string","null"] union, so a nullable field would 400 the whole call.
  it("turns a nullable type union into nullable: true", () => {
    expect(toGeminiSchema({ type: ["string", "null"] })).toEqual({
      type: "string",
      nullable: true,
    });
  });

  // Catches: dropping enum. §12.13's verify hop constrains `verdict` to a
  // closed set; without this the verifier can answer anything and the "any
  // refuted field -> revisar" rule silently never fires.
  it("passes enum through on a string property", () => {
    const out = toGeminiSchema({ type: "string", enum: ["confirmado", "refutado", "ilegivel"] });
    expect(out["enum"]).toEqual(["confirmado", "refutado", "ilegivel"]);
  });

  // Catches: losing the field-list order (§3.1). Without propertyOrdering two
  // extractions of the same document diff as if every field moved.
  it("emits propertyOrdering in field-list order", () => {
    const out = toGeminiSchema({
      type: "object",
      properties: { numero: { type: "string" }, total: { type: "number" } },
      required: ["numero"],
    });
    expect(out["propertyOrdering"]).toEqual(["numero", "total"]);
    expect(out["required"]).toEqual(["numero"]);
  });

  // Catches: marking a nullable field required. Gemini treats `required` as
  // "must be present AND non-null", so a nullable-but-required field makes
  // every document without that field an error instead of a null.
  it("does not require a field whose type is a union", () => {
    const out = toGeminiSchema({
      type: "object",
      properties: { obs: { type: ["string", "null"] } },
      required: ["obs"],
    });
    expect(out["required"]).toBeUndefined();
  });

  it("recurses into array items", () => {
    const out = toGeminiSchema({
      type: "array",
      items: { type: "object", properties: { qtd: { type: "number" } } },
    });
    expect(out["items"]).toMatchObject({ type: "object", propertyOrdering: ["qtd"] });
  });
});

describe("geminiAdapter.send — payload mapping", () => {
  it("maps system, model, prompt and maxTokens onto the SDK call", async () => {
    h.generateContent.mockResolvedValue(OK);
    await geminiAdapter.send(BASE, "key-1");
    const call = lastCall();
    expect(call["model"]).toBe("gemini-3.5-flash");
    expect(call["config"]).toMatchObject({
      systemInstruction: "sys",
      maxOutputTokens: 4096,
      temperature: 0,
    });
    expect(call["contents"]).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  });

  // Catches: letting the caller set responseMimeType. It is what makes the
  // answer parseable at all, so it is ours and is applied last.
  it("applies responseMimeType and the translated schema when a schema is present", async () => {
    h.generateContent.mockResolvedValue(OK);
    await geminiAdapter.send(
      { ...BASE, schema: { type: "object", properties: { a: { type: "string" } } } },
      "key-1",
    );
    const config = lastCall()["config"] as Record<string, unknown>;
    expect(config["responseMimeType"]).toBe("application/json");
    expect(config["responseSchema"]).toMatchObject({ type: "object", propertyOrdering: ["a"] });
  });

  // Catches: forcing JSON on a free-text hop, which would make the model wrap
  // prose in a string literal.
  it("omits responseMimeType when the job carries no schema", async () => {
    h.generateContent.mockResolvedValue(OK);
    await geminiAdapter.send(BASE, "key-1");
    const config = lastCall()["config"] as Record<string, unknown>;
    expect(config["responseMimeType"]).toBeUndefined();
    expect(config["responseSchema"]).toBeUndefined();
  });

  it("attaches an inline document as inlineData after the prompt", async () => {
    h.generateContent.mockResolvedValue(OK);
    await geminiAdapter.send(
      { ...BASE, document: { kind: "inline", mimeType: "application/pdf", data: "QUJD" } },
      "key-1",
    );
    expect(lastCall()["contents"]).toEqual([
      {
        role: "user",
        parts: [{ text: "hi" }, { inlineData: { mimeType: "application/pdf", data: "QUJD" } }],
      },
    ]);
  });

  // Catches: sending a Files API id as inlineData (or as text). §12.3's handle
  // is a URI, not bytes.
  it("attaches a hosted document as fileData", async () => {
    h.generateContent.mockResolvedValue(OK);
    await geminiAdapter.send(
      { ...BASE, document: { kind: "hosted", mimeType: "application/pdf", fileId: "files/abc" } },
      "key-1",
    );
    const parts = (lastCall()["contents"] as { parts: unknown[] }[])[0]?.parts;
    expect(parts?.[1]).toEqual({
      fileData: { mimeType: "application/pdf", fileUri: "files/abc" },
    });
  });
});

describe("geminiAdapter.send — result mapping", () => {
  // Catches: omitting thoughtsTokenCount. Gemini 3.x bills thinking tokens at
  // the OUTPUT rate and they cannot be disabled, so dropping them under-bills
  // every single call.
  it("counts thinking tokens as output tokens", async () => {
    h.generateContent.mockResolvedValue(OK);
    const res = await geminiAdapter.send(BASE, "key-1");
    expect(res).toEqual({
      content: '{"ok":true}',
      usage: { input_tokens: 100, output_tokens: 27 },
      model: "gemini-3.5-flash",
      provider: "gemini",
    });
  });

  // Catches: silent underbilling. Canonical usage feeds billing; a success
  // with no usage metadata must fail the job, not write a zero-cost row.
  it("treats content without usage metadata as permanent (never bill zero)", async () => {
    h.generateContent.mockResolvedValue({ text: "x" });
    await expect(geminiAdapter.send(BASE, "key-1")).rejects.toBeInstanceOf(PermanentError);
  });

  // Catches: returning the empty string. A 200 with no candidate is a safety
  // block or an empty generation, which repeats on the same input.
  it("treats a 200 with no text as permanent", async () => {
    h.generateContent.mockResolvedValue({ text: "" });
    await expect(geminiAdapter.send(BASE, "key-1")).rejects.toBeInstanceOf(PermanentError);
  });
});

describe("geminiAdapter.send — failure classification", () => {
  // Catches: retrying a 400. It will fail identically however often it runs,
  // so retrying only spends the collector's attempts to re-learn that.
  it("classifies a non-429 4xx as permanent", async () => {
    h.generateContent.mockRejectedValue(Object.assign(new Error("bad request"), { status: 400 }));
    await expect(geminiAdapter.send(BASE, "key-1")).rejects.toBeInstanceOf(PermanentError);
  });

  // Catches: lumping throttling in with the other 4xx. A 429 is exactly the
  // case another attempt fixes.
  it("leaves a 429 transient", async () => {
    h.generateContent.mockRejectedValue(Object.assign(new Error("slow down"), { status: 429 }));
    await expect(geminiAdapter.send(BASE, "key-1")).rejects.not.toBeInstanceOf(PermanentError);
  });

  it("leaves a 5xx transient", async () => {
    h.generateContent.mockRejectedValue(Object.assign(new Error("boom"), { status: 503 }));
    await expect(geminiAdapter.send(BASE, "key-1")).rejects.not.toBeInstanceOf(PermanentError);
  });

  // The SDK does not always attach `status`; the code falls back to the message.
  it("reads the status out of the message when the error has no status field", async () => {
    h.generateContent.mockRejectedValue(new Error("got status 403 from upstream"));
    await expect(geminiAdapter.send(BASE, "key-1")).rejects.toBeInstanceOf(PermanentError);
  });

  // Catches: classifying an unrecognised fault as permanent. Unknown means
  // transient, because the two mistakes are not symmetric.
  it("leaves an unclassifiable failure transient", async () => {
    h.generateContent.mockRejectedValue(new Error("socket hang up"));
    await expect(geminiAdapter.send(BASE, "key-1")).rejects.not.toBeInstanceOf(PermanentError);
  });
});

describe("geminiAdapter — client caching", () => {
  // Catches: caching one client for the container. Under BYOK a warm container
  // serves many tenants, and reusing the previous tenant's client would bill
  // their key for this tenant's call.
  it("builds one client per API key, and reuses it", async () => {
    h.generateContent.mockResolvedValue(OK);
    await geminiAdapter.send(BASE, "key-a");
    await geminiAdapter.send(BASE, "key-a");
    await geminiAdapter.send(BASE, "key-b");
    expect(h.constructedWith).toEqual(["key-a", "key-b"]);
  });
});
