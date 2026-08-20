// api/services/credentials-service.test.ts
//
// §6's model scope and §7's key ownership, in the ONE place that resolves
// both. Four properties:
//
//   1. NO ROW → the platform default for the hop, on the platform key. That is
//      every account until someone configures one, which is why nothing
//      upstream null-checks this.
//   2. A ROW'S `model` OVERRIDES — except for `verify`, where §12.13 requires
//      a different model from the generator and one column cannot express two.
//   3. `ssm_param_name` DECIDES KEY OWNERSHIP, and it applies to EVERY hop
//      including verify: whose key pays is a different question from who
//      checks.
//   4. UNPRICED IS REFUSED BEFORE THE MONEY IS SPENT (§10.5) — on the platform
//      key only, because BYOK bills zero by definition.

import { describe, it, expect, vi } from "vitest";
import {
  allowedTenantParamName,
  keyBinding,
  PLATFORM_DEFAULTS,
  resolveModel,
} from "./credentials-service";
import type { DbLike } from "../collector/job-state";

const TENANT = "org_2abcTENANT";
const PARAM = `/reportflow/tenants/${TENANT}/gemini-api-key`;

function makeDb(row?: { model: string | null; ssmParamName: string | null }) {
  const limit = vi.fn().mockResolvedValue(row === undefined ? [] : [row]);
  const select = vi.fn().mockReturnValue({
    from: () => ({ where: () => ({ limit }) }),
  });
  return { db: { select } as unknown as DbLike, select };
}

describe("resolveModel — no credential row", () => {
  it("returns the hop's platform default on the platform key", async () => {
    const { db } = makeDb();
    await expect(resolveModel(db, TENANT, "extract")).resolves.toEqual({
      ...PLATFORM_DEFAULTS.extract,
      byok: null,
    });
  });

  // §6 — "extraction is accuracy-critical; analysis is prose; detection is
  // trivial". Pinned so a tier change is a deliberate edit.
  it("gives each hop its own tier", async () => {
    const { db } = makeDb();
    const extract = await resolveModel(db, TENANT, "extract");
    const detect = await resolveModel(db, TENANT, "detect");
    const analyse = await resolveModel(db, TENANT, "analyse");
    expect(extract.model).not.toBe(detect.model);
    expect(analyse.model).toBe(PLATFORM_DEFAULTS.analyse.model);
  });
});

describe("resolveModel — an account-level default (§6)", () => {
  it("overrides the model for a generator hop", async () => {
    const { db } = makeDb({ model: "gemini-2.5-flash", ssmParamName: null });
    await expect(resolveModel(db, TENANT, "extract")).resolves.toEqual({
      provider: "gemini",
      model: "gemini-2.5-flash",
      byok: null,
    });
  });

  it("ignores an empty or null model column", async () => {
    const { db } = makeDb({ model: null, ssmParamName: null });
    await expect(resolveModel(db, TENANT, "analyse")).resolves.toMatchObject({
      model: PLATFORM_DEFAULTS.analyse.model,
    });
  });

  // §12.13 — the verifier must be a DIFFERENT model than the generator. A
  // single account-level `model` column cannot express two models, so letting
  // it reach `verify` would collapse the adversary onto the thing it audits
  // and delete the guarantee silently.
  it("does NOT let the account model reach the verify hop", async () => {
    const { db } = makeDb({ model: "gemini-2.5-flash", ssmParamName: null });
    // BYOK, so the (deliberately unpriced) verifier default is allowed through.
    const { db: byokDb } = makeDb({ model: "gemini-2.5-flash", ssmParamName: PARAM });
    void db;
    await expect(resolveModel(byokDb, TENANT, "verify")).resolves.toMatchObject({
      model: PLATFORM_DEFAULTS.verify.model,
    });
  });
});

describe("resolveModel — BYOK (§7, §12.7)", () => {
  it("reports the parameter NAME, never a key", async () => {
    const { db } = makeDb({ model: null, ssmParamName: PARAM });
    await expect(resolveModel(db, TENANT, "extract")).resolves.toEqual({
      ...PLATFORM_DEFAULTS.extract,
      byok: { ssmParamName: PARAM },
    });
  });

  // Whose key pays is a different question from who checks — the model
  // exception above is about §12.13, not about billing.
  it("applies to the verify hop too", async () => {
    const { db } = makeDb({ model: null, ssmParamName: PARAM });
    await expect(resolveModel(db, TENANT, "verify")).resolves.toMatchObject({
      byok: { ssmParamName: PARAM },
    });
  });

  // §7 — "any model allowed; pricing table irrelevant". The verifier's default
  // is deliberately unpriced (see api/billing/cost-of-goods.ts), so this is
  // also the case that proves BYOK is not gated on the rate card.
  it("allows an unpriced model that the platform key would refuse", async () => {
    const { db: byok } = makeDb({ model: null, ssmParamName: PARAM });
    await expect(resolveModel(byok, TENANT, "verify")).resolves.toMatchObject({
      model: PLATFORM_DEFAULTS.verify.model,
    });

    const { db: platform } = makeDb();
    await expect(resolveModel(platform, TENANT, "verify")).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
  });
});

// §12.7. The relay refuses a parameter outside the tenant's own path, and the
// `ai_credentials` CHECK pins the prefix — but a PREFIX is not a PATH. A row
// naming another tenant's parameter passes both and produces a job the relay
// throws away as a PermanentError, after the API has already written a job
// object and a `report_jobs` row for it. So the exact name is recomputed here.
describe("resolveModel — the BYOK parameter SHAPE (§12.7)", () => {
  // THE PIN between the two bundles. relay/src/secrets.ts builds the same
  // string from `TENANT_PREFIX` and refuses anything else; they cannot import
  // each other, so a literal on each side is what keeps them honest — change
  // one and this comparison fails.
  it("is byte-for-byte the path relay/src/secrets.ts allows", () => {
    expect(allowedTenantParamName(TENANT, "gemini")).toBe(
      `/reportflow/tenants/${TENANT}/gemini-api-key`,
    );
    expect(allowedTenantParamName(TENANT, "gemini")).toBe(PARAM);
  });

  it("refuses another tenant's parameter, even under the right prefix", async () => {
    const { db } = makeDb({
      model: null,
      ssmParamName: "/reportflow/tenants/org_2zzzOTHER/gemini-api-key",
    });
    await expect(resolveModel(db, TENANT, "extract")).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
  });

  it("refuses the right tenant with the wrong provider leaf", async () => {
    const { db } = makeDb({
      model: null,
      ssmParamName: `/reportflow/tenants/${TENANT}/openai-api-key`,
    });
    await expect(resolveModel(db, TENANT, "extract")).rejects.toThrow(/parâmetro inválido/u);
  });

  it("refuses a deeper path that merely starts with the allowed one", async () => {
    const { db } = makeDb({ model: null, ssmParamName: `${PARAM}/extra` });
    await expect(resolveModel(db, TENANT, "extract")).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
  });

  // The refusal must beat the enqueue, not follow it: a doomed job costs a
  // `report_jobs` row, an S3 object and a support question.
  it("names the only allowed parameter, in pt-BR", async () => {
    const { db } = makeDb({ model: null, ssmParamName: "/reportflow/tenants/x/gemini-api-key" });
    await expect(resolveModel(db, TENANT, "extract")).rejects.toThrow(PARAM);
  });
});

describe("resolveModel — §10.5's fail-closed refusal", () => {
  it("refuses a platform-key hop on a model nobody priced, before any call", async () => {
    const { db } = makeDb({ model: "gemini-4-ultra", ssmParamName: null });
    await expect(resolveModel(db, TENANT, "extract")).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
  });

  it("says so in pt-BR, naming the model and the hop", async () => {
    const { db } = makeDb({ model: "gemini-4-ultra", ssmParamName: null });
    await expect(resolveModel(db, TENANT, "extract")).rejects.toThrow(/gemini-4-ultra/u);
  });
});

describe("keyBinding", () => {
  it("is empty for the platform key and names the parameter for BYOK", () => {
    expect(keyBinding({ provider: "gemini", model: "m", byok: null })).toEqual({});
    expect(keyBinding({ provider: "gemini", model: "m", byok: { ssmParamName: PARAM } })).toEqual({
      ssmParamName: PARAM,
    });
  });
});
