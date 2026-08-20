// api/billing/charge.test.ts
//
// THE LEDGER WRITE (§7, §12.6). Four properties, and none of them is "does it
// insert a row":
//
//   1. THE FORK IS KEY OWNERSHIP. Platform key → raw = costFor, owed = raw ×
//      mult. BYOK → raw = 0, owed = 0, ANY model, and the row is STILL
//      written.
//   2. UNPRICED IS NOT FREE. A platform-key hop on a model nobody priced
//      THROWS rather than writing a zero (§10.5).
//   3. `ref_id` IS THE IDEMPOTENCY, it carries the provider (§12.6), and the
//      insert says ON CONFLICT DO NOTHING.
//   4. `owed` IS FROZEN AT WRITE TIME — computed from the multiplier as it
//      stands, never recalculated later.

import { describe, it, expect, vi } from "vitest";
import {
  chargeRefId,
  multiplierKey,
  readBillingBinding,
  readByok,
  readUsage,
  UnpricedModelError,
  writeCharge,
} from "./charge";
import type { DbLike } from "../collector/job-state";

const TENANT = "org_2abcTENANT";
const USAGE = { input_tokens: 1_000_000, output_tokens: 1_000_000 };

/** A fake handle that records the inserted values and reports the configured
 * `credit_config` multiplier. */
function makeDb(multiplier?: number) {
  const values = vi.fn().mockReturnValue({
    onConflictDoNothing: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: "charge-1" }]),
    }),
  });
  const insert = vi.fn().mockReturnValue({ values });
  const select = vi.fn().mockReturnValue({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(multiplier === undefined ? [] : [{ value: multiplier }]),
      }),
    }),
  });
  return { db: { insert, select } as unknown as DbLike, values, insert };
}

function inserted(values: ReturnType<typeof makeDb>["values"]): Record<string, unknown> {
  return values.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe("chargeRefId — §12.6's grammar", () => {
  it("uses the prefix the design named, per source", () => {
    expect(chargeRefId("extract", "gemini", "m", "k")).toBe("report_extraction:gemini:m:k");
    expect(chargeRefId("analyse", "gemini", "m", "k")).toBe("report_analysis:gemini:m:k");
    expect(chargeRefId("verify", "gemini", "m", "k")).toBe("report_verify:gemini:m:k");
    expect(chargeRefId("detect", "gemini", "m", "k")).toBe("report_detect:gemini:m:k");
  });

  // "Model names are not globally unique across providers" — §12.6's whole
  // reason for existing.
  it("distinguishes the same model name under two providers", () => {
    expect(chargeRefId("extract", "a", "m", "k")).not.toBe(chargeRefId("extract", "b", "m", "k"));
  });

  it("keys credit_config on the source", () => {
    expect(multiplierKey("analyse")).toBe("mult.analyse");
  });
});

describe("reading a job payload back", () => {
  it("finds the binding a job builder spread onto the payload", () => {
    expect(readBillingBinding({ billing: { source: "verify", refKey: "x" } })).toEqual({
      source: "verify",
      refKey: "x",
    });
  });

  it("returns null for a payload with no binding, or a nonsense one", () => {
    expect(readBillingBinding({})).toBeNull();
    expect(readBillingBinding(null)).toBeNull();
    expect(readBillingBinding({ billing: { source: "nope", refKey: "x" } })).toBeNull();
    expect(readBillingBinding({ billing: { source: "verify", refKey: "" } })).toBeNull();
  });

  // ONE fact, ONE field: `ssmParamName` is what the relay reads to decide
  // whose key to fetch, so reading key ownership off anything else would be a
  // second statement that can disagree — and the billing copy would be the
  // one that bills a tenant for a call made on their own key.
  it("reads BYOK off the same field the relay reads", () => {
    expect(readByok({ ssmParamName: "/reportflow/tenants/org/gemini-api-key" })).toBe(true);
    expect(readByok({})).toBe(false);
    expect(readByok({ byok: true })).toBe(false);
  });

  it("narrows a usage envelope defensively", () => {
    expect(readUsage({ input_tokens: 5, output_tokens: 7 })).toEqual({
      input_tokens: 5,
      output_tokens: 7,
    });
    expect(readUsage(undefined)).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(readUsage({ input_tokens: "many" })).toEqual({ input_tokens: 0, output_tokens: 0 });
  });
});

describe("writeCharge — the platform-key path", () => {
  it("bills raw = costFor and owed = raw × the configured multiplier", async () => {
    const { db, values } = makeDb(200);
    await writeCharge(db, {
      refId: "report_extraction:gemini:gemini-2.5-flash:k",
      tenantId: TENANT,
      source: "extract",
      provider: "gemini",
      model: "gemini-2.5-flash",
      usage: USAGE,
      byok: false,
    });
    // 30¢ + 250¢ per 1M each = 280.
    expect(inserted(values)).toMatchObject({
      rawUsdCents: "280",
      multX100: 200,
      owedUsdCents: "560",
      tenantId: TENANT,
      source: "extract",
    });
  });

  // "A missing config row must not stop a hop, and 1× is the only default that
  // cannot over-charge" — smartstocke's reasoning, kept.
  it("falls back to the identity multiplier when credit_config has no row", async () => {
    const { db, values } = makeDb(undefined);
    await writeCharge(db, {
      refId: "r",
      tenantId: TENANT,
      source: "analyse",
      provider: "gemini",
      model: "gemini-2.5-flash",
      usage: USAGE,
      byok: false,
    });
    expect(inserted(values)).toMatchObject({
      multX100: 100,
      rawUsdCents: "280",
      owedUsdCents: "280",
    });
  });

  // §7, §10.5. The refusal is the feature: it costs someone a deploy rather
  // than costing the business the revenue.
  it("REFUSES to write a zero for a model nobody priced", async () => {
    const { db, insert } = makeDb(100);
    await expect(
      writeCharge(db, {
        refId: "r",
        tenantId: TENANT,
        source: "verify",
        provider: "gemini",
        model: "gemini-3.1-pro-preview",
        usage: USAGE,
        byok: false,
      }),
    ).rejects.toBeInstanceOf(UnpricedModelError);
    expect(insert).not.toHaveBeenCalled();
  });
});

describe("writeCharge — BYOK", () => {
  // "raw = 0, owed = 0, row still written (ref_id UNIQUE = same idempotency),
  // any model allowed; pricing table irrelevant" — §7, verbatim.
  it("bills nothing and still writes the row, on an UNPRICED model", async () => {
    const { db, values } = makeDb(500);
    await writeCharge(db, {
      refId: "r",
      tenantId: TENANT,
      source: "verify",
      provider: "gemini",
      model: "gemini-3.1-pro-preview",
      usage: USAGE,
      byok: true,
    });
    expect(inserted(values)).toMatchObject({
      rawUsdCents: "0",
      owedUsdCents: "0",
      multX100: 0,
      model: "gemini-3.1-pro-preview",
    });
  });

  it("keeps the usage envelope even though it bills zero", async () => {
    const { db, values } = makeDb();
    await writeCharge(db, {
      refId: "r",
      tenantId: TENANT,
      source: "extract",
      provider: "gemini",
      model: "whatever",
      usage: { input_tokens: 11, output_tokens: 22 },
      byok: true,
    });
    expect(inserted(values)).toMatchObject({ usage: { input_tokens: 11, output_tokens: 22 } });
  });
});

describe("writeCharge — idempotency", () => {
  it("reports the duplicate rather than throwing when ref_id already exists", async () => {
    const returning = vi.fn().mockResolvedValue([]);
    const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    const db = {
      insert: vi.fn().mockReturnValue({ values }),
      select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) }),
    } as unknown as DbLike;

    await expect(
      writeCharge(db, {
        refId: "r",
        tenantId: TENANT,
        source: "extract",
        provider: "gemini",
        model: "gemini-2.5-flash",
        usage: USAGE,
        byok: false,
      }),
    ).resolves.toEqual({ written: false });
    // The ONE thing that makes an at-least-once delivery free.
    expect(onConflictDoNothing).toHaveBeenCalled();
  });
});
