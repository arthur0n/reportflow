// relay/src/relay-handler.test.ts
//
// Delivery semantics: at-least-once S3 events, the conditional result write,
// and the rule that a classified failure is ANSWERED rather than thrown.
//
// S3 and the channel are both mocked. The point of these cases is what the
// handler does with their answers, not what they answer.

import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  exists: vi.fn(),
  readText: vi.fn(),
  putIfAbsent: vi.fn(),
  deleteQuietly: vi.fn(),
  aiChannel: vi.fn(),
}));

vi.mock("./s3", () => ({
  exists: h.exists,
  readText: h.readText,
  putIfAbsent: h.putIfAbsent,
  deleteQuietly: h.deleteQuietly,
  docsBucket: () => "reportflow-docs-prod",
  readBase64: vi.fn(),
  isMissing: vi.fn(),
}));

vi.mock("./channels/ai", () => ({ aiChannel: h.aiChannel }));

const { handler } = await import("./relay-handler");
const { PermanentError } = await import("./errors");

const BUCKET = "reportflow-docs-prod";
const TENANT = "org_2abcDEF";
const JOB = "1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d-a1";
const JOB_KEY = `jobs/${TENANT}/${JOB}.json`;
const RESULT_KEY = `results/${TENANT}/${JOB}.json`;
const CLAIM_KEY = `claims/${TENANT}/${JOB}.json`;

const JOB_BODY = JSON.stringify({
  channel: "ai",
  kind: "extract",
  tenantId: TENANT,
  provider: "gemini",
  model: "gemini-3.5-flash",
  system: "sistema",
  prompt: "extraia",
  maxTokens: 8192,
});

const RESULT = {
  content: '{"numero":"FT 1"}',
  usage: { input_tokens: 100, output_tokens: 27 },
  model: "gemini-3.5-flash",
  provider: "gemini",
};

function event(key = JOB_KEY): Parameters<typeof handler>[0] {
  return {
    Records: [{ s3: { bucket: { name: BUCKET }, object: { key } } }],
  } as Parameters<typeof handler>[0];
}

/** What was actually written to results/, parsed. The claim is also a
 * conditional write, so the result is located by KEY rather than by call
 * order — a positional lookup would silently start reading the claim. */
function written(): unknown {
  const call = h.putIfAbsent.mock.calls.find((c) => String(c[1]).startsWith("results/"));
  return JSON.parse(String(call?.[2]));
}

/** Whether the claim was taken. */
function claimed(): boolean {
  return h.putIfAbsent.mock.calls.some((c) => c[1] === CLAIM_KEY);
}

/** Conditional writes succeed unless the test says otherwise, per prefix. */
function conditionalWrites(over: { claim?: boolean; result?: boolean } = {}): void {
  h.putIfAbsent.mockImplementation((_bucket: string, key: string) =>
    Promise.resolve(key.startsWith("claims/") ? (over.claim ?? true) : (over.result ?? true)),
  );
}

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  h.exists.mockResolvedValue(false);
  h.readText.mockResolvedValue(JOB_BODY);
  conditionalWrites();
  h.deleteQuietly.mockResolvedValue(undefined);
  h.aiChannel.mockResolvedValue(RESULT);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("handler — happy path", () => {
  it("writes the canonical result verbatim and deletes the job", async () => {
    await handler(event());
    expect(h.putIfAbsent).toHaveBeenCalledWith(BUCKET, RESULT_KEY, JSON.stringify(RESULT));
    expect(written()).toEqual(RESULT);
    expect(h.deleteQuietly).toHaveBeenCalledWith(BUCKET, JOB_KEY);
  });

  // The claim is what stops two concurrent deliveries both being billed, so it
  // is worthless taken afterwards.
  it("claims the job before calling the provider", async () => {
    await handler(event());
    const claimCall = h.putIfAbsent.mock.invocationCallOrder[0];
    const channelCall = h.aiChannel.mock.invocationCallOrder[0];
    expect(h.putIfAbsent.mock.calls[0]?.[1]).toBe(CLAIM_KEY);
    expect(claimCall).toBeLessThan(channelCall ?? 0);
  });

  // A claim left behind is expired by the bucket lifecycle rule; deleting it
  // would reopen the job to any redelivery that raced the result write.
  it("does not release the claim after a successful answer", async () => {
    await handler(event());
    expect(h.deleteQuietly).not.toHaveBeenCalledWith(BUCKET, CLAIM_KEY);
  });

  it("passes the parsed job, bound to the key's tenant, to the channel", async () => {
    await handler(event());
    expect(h.aiChannel).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "ai", kind: "extract", tenantId: TENANT }),
    );
  });

  it("URL-decodes the key S3 delivered", async () => {
    await handler(event(`jobs/${TENANT}/${JOB}.json`.replace(/\//gu, "%2F")));
    expect(h.readText).toHaveBeenCalledWith(BUCKET, JOB_KEY);
  });
});

describe("handler — idempotency (S3 events are at-least-once)", () => {
  // THE case. Catches: re-running the provider call on a redelivery, which is
  // a second bill for a report that was already paid for and answered.
  it("skips the whole job when the result is already there", async () => {
    h.exists.mockResolvedValue(true);
    await handler(event());
    expect(h.readText).not.toHaveBeenCalled();
    expect(h.aiChannel).not.toHaveBeenCalled();
    expect(h.putIfAbsent).not.toHaveBeenCalled();
    expect(claimed()).toBe(false);
    // Still cleaned up: leaving the job object behind means the same duplicate
    // arrives again on the next lifecycle sweep.
    expect(h.deleteQuietly).toHaveBeenCalledWith(BUCKET, JOB_KEY);
  });

  // Catches: an unconditional PutObject. A delivery that took the claim after a
  // leaked one expired must not overwrite a result the original winner wrote
  // late, so the answer is ordered too, not just the provider call.
  it("writes the result conditionally, so a concurrent delivery cannot overwrite it", async () => {
    conditionalWrites({ result: false });
    await expect(handler(event())).resolves.toBeUndefined();
    expect(h.deleteQuietly).toHaveBeenCalledWith(BUCKET, JOB_KEY);
  });

  // THE double-billing case. Catches: check-then-act on the result alone — both
  // deliveries see no result, both call the provider, and the tenant is billed
  // twice for one report.
  it("stands down without calling the provider when another delivery holds the claim", async () => {
    conditionalWrites({ claim: false });
    await expect(handler(event())).resolves.toBeUndefined();
    expect(h.aiChannel).not.toHaveBeenCalled();
    expect(h.readText).not.toHaveBeenCalled();
    expect(h.putIfAbsent).toHaveBeenCalledTimes(1);
    expect(h.putIfAbsent.mock.calls[0]?.[1]).toBe(CLAIM_KEY);
  });

  // The winner deletes the job. A loser that deleted it would remove the object
  // the winner is still reading.
  it("leaves the job object alone when it loses the claim", async () => {
    conditionalWrites({ claim: false });
    await handler(event());
    expect(h.deleteQuietly).not.toHaveBeenCalled();
  });
});

describe("handler — failure classification (§12.1)", () => {
  // Catches: throwing on a provider failure. Retries are NEW JOBS enqueued by
  // the collector under an incremented attempt number; a thrown invoke leaves
  // the collector with nothing to read and the report_jobs row pending forever.
  it("writes a transient error rather than throwing", async () => {
    h.aiChannel.mockRejectedValue(new Error("socket hang up"));
    await handler(event());
    expect(written()).toEqual({ error: { type: "transient", message: "socket hang up" } });
  });

  it("writes a permanent error for a reviewed permanent failure", async () => {
    h.aiChannel.mockRejectedValue(new PermanentError("gemini 400: bad schema"));
    await handler(event());
    expect(written()).toEqual({
      error: { type: "permanent", message: "gemini 400: bad schema" },
    });
  });

  // A malformed payload never reaches the provider, and it will be malformed
  // again next time — so it is answered, not retried.
  it("writes a permanent error when the payload does not parse", async () => {
    h.readText.mockResolvedValue(JSON.stringify({ channel: "email" }));
    await handler(event());
    expect(written()).toMatchObject({ error: { type: "permanent" } });
  });

  // Catches: deriving a result key from an unparsed string. There is nowhere
  // to write an answer for a key we cannot parse, so the invoke fails and the
  // key shows up in the logs instead of a result landing somewhere it should
  // not.
  it("throws on an unparseable job key instead of guessing a result key", async () => {
    await expect(handler(event(`jobs/${TENANT}/nested/${JOB}.json`))).rejects.toBeInstanceOf(
      PermanentError,
    );
    expect(h.putIfAbsent).not.toHaveBeenCalled();
  });

  // Catches: swallowing an S3 write failure. Nothing was written, so the
  // collector would wait forever; the invoke must fail so the retry happens.
  it("rethrows when the result cannot be written at all", async () => {
    h.putIfAbsent.mockImplementation((_b: string, key: string) =>
      key.startsWith("claims/")
        ? Promise.resolve(true)
        : Promise.reject(new Error("s3 unavailable")),
    );
    await expect(handler(event())).rejects.toThrow(/s3 unavailable/u);
  });

  // Catches: holding the claim through a failure that wrote nothing. Nobody can
  // read an answer, so the retry has to be able to take the job back.
  it("releases the claim when no result could be written", async () => {
    h.putIfAbsent.mockImplementation((_b: string, key: string) =>
      key.startsWith("claims/")
        ? Promise.resolve(true)
        : Promise.reject(new Error("s3 unavailable")),
    );
    await expect(handler(event())).rejects.toThrow();
    expect(h.deleteQuietly).toHaveBeenCalledWith(BUCKET, CLAIM_KEY);
    expect(h.deleteQuietly).not.toHaveBeenCalledWith(BUCKET, JOB_KEY);
  });
});
