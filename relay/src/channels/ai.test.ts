// relay/src/channels/ai.test.ts
//
// The channel is four steps and no decisions (relay_lambda.md's dumb-sender
// rule). These cases pin the two that are easy to get subtly wrong: turning an
// S3 key into bytes an adapter can attach, and doing the cheap refusals BEFORE
// paying for a 25 MB read.

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  readBase64: vi.fn(),
  resolveApiKey: vi.fn(),
  send: vi.fn(),
}));

vi.mock("../s3", () => ({
  readBase64: h.readBase64,
  docsBucket: () => "reportflow-docs-prod",
}));

vi.mock("../secrets", () => ({ resolveApiKey: h.resolveApiKey }));

vi.mock("../providers/registry", () => ({
  getAdapter: (provider: string) => {
    if (provider !== "gemini") {
      throw new (class extends Error {})("unknown provider");
    }
    return { provider: "gemini", send: h.send };
  },
}));

const { aiChannel } = await import("./ai");
const { parseJob } = await import("../job");

const TENANT = "org_2abcDEF";

/** Built through the real parser: the channel only ever receives a job that
 * survived `parseJob`, so a hand-typed one could pin behaviour on a shape the
 * relay never sees. */
function job(over: Record<string, unknown> = {}): Parameters<typeof aiChannel>[0] {
  return parseJob(
    {
      channel: "ai",
      kind: "extract",
      tenantId: TENANT,
      provider: "gemini",
      model: "gemini-3.5-flash",
      system: "sistema",
      prompt: "extraia",
      maxTokens: 8192,
      ...over,
    },
    TENANT,
  );
}

beforeEach(() => {
  h.readBase64.mockReset().mockResolvedValue("QUJD");
  h.resolveApiKey.mockReset().mockResolvedValue("sk-live");
  h.send.mockReset().mockResolvedValue({
    content: "{}",
    usage: { input_tokens: 1, output_tokens: 2 },
    model: "gemini-3.5-flash",
    provider: "gemini",
  });
});

describe("aiChannel", () => {
  it("reads the document out of the documents bucket and attaches it inline", async () => {
    await aiChannel(job({ document: { s3Key: `${TENANT}/abc.pdf` } }));
    expect(h.readBase64).toHaveBeenCalledWith("reportflow-docs-prod", `${TENANT}/abc.pdf`);
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({
        document: { kind: "inline", mimeType: "application/pdf", data: "QUJD" },
      }),
      "sk-live",
    );
  });

  // §12.3 — a Files API handle is a URI, not bytes. Reading S3 for it would be
  // both wrong and a read of a key that may not exist.
  it("passes a file id straight through without touching S3", async () => {
    await aiChannel(
      job({
        document: { fileId: "files/abc", fileProvider: "gemini", fileKeyOwner: "platform" },
      }),
    );
    expect(h.readBase64).not.toHaveBeenCalled();
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({
        document: { kind: "hosted", mimeType: "application/pdf", fileId: "files/abc" },
      }),
      "sk-live",
    );
  });

  // §12.3 again, from the other side: hop 2 reads extraction JSON, never a PDF.
  it("sends no document at all for a job that has none", async () => {
    await aiChannel(job());
    expect(h.readBase64).not.toHaveBeenCalled();
    const req = h.send.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("document" in req).toBe(false);
    expect("schema" in req).toBe(false);
  });

  it("forwards the schema when the job carries one", async () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    await aiChannel(job({ schema }));
    expect(h.send).toHaveBeenCalledWith(expect.objectContaining({ schema }), "sk-live");
  });

  // Catches: resolving the document before the provider. An unknown provider is
  // permanent, and finding that out after loading 25 MB of PDF into memory
  // costs a read and the container's headroom for nothing.
  it("refuses an unknown provider before reading anything", async () => {
    await expect(
      aiChannel(job({ provider: "anthropic", document: { s3Key: `${TENANT}/abc.pdf` } })),
    ).rejects.toThrow();
    expect(h.readBase64).not.toHaveBeenCalled();
    expect(h.resolveApiKey).not.toHaveBeenCalled();
  });

  it("returns the adapter's canonical result untouched", async () => {
    const res = await aiChannel(job());
    expect(res).toEqual({
      content: "{}",
      usage: { input_tokens: 1, output_tokens: 2 },
      model: "gemini-3.5-flash",
      provider: "gemini",
    });
  });
});
