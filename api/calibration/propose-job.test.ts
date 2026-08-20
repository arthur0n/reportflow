// api/calibration/propose-job.test.ts
//
// The proposal hop's payload. Two properties carry the design:
//
//   1. It is a CANONICAL §6 job — `channel: "ai"`, a kind the relay's closed
//      set contains, the tenant bound to the payload, the document by key.
//      Anything else is refused by relay/src/job.ts `parseJob` at the far end,
//      where the failure is a paid round trip away from being noticed.
//   2. It carries `purpose: "calibrate"` and rides `kind: "analyse"`. That is
//      the one thing distinguishing this job from a report analysis, and the
//      API reads it back off `report_jobs.request`.

import { describe, it, expect } from "vitest";
import { PLATFORM_DEFAULTS } from "../services/credentials-service";
import {
  buildCalibrateJob,
  calibrateRefKey,
  isCalibrateRequest,
  CALIBRATE_MAX_TOKENS,
  PAGE_TEXT_BUDGET,
} from "./propose-job";

const TENANT = "org_2abcTENANT";
const CALIBRATE_PROVIDER = PLATFORM_DEFAULTS.calibrate.provider;
const CALIBRATE_MODEL = PLATFORM_DEFAULTS.calibrate.model;

/** The platform-default model pair, which every case here shares — #10 made
 * (provider, model) an argument (api/services/credentials-service.ts), and
 * repeating it per case would say nothing. */
function job(over: { pageOneText: string | null } & Record<string, unknown>) {
  return buildCalibrateJob({
    tenantId: TENANT,
    s3Key: S3_KEY,
    provider: CALIBRATE_PROVIDER,
    model: CALIBRATE_MODEL,
    ...over,
  });
}
const S3_KEY = `${TENANT}/sample.pdf`;

describe("buildCalibrateJob", () => {
  it("builds a canonical ai job bound to the caller's own tenant and document", () => {
    const payload = job({
      pageOneText: "TOYSMITH COMÉRCIO\nNOTA FISCAL",
    });

    expect(payload["channel"]).toBe("ai");
    expect(payload["tenantId"]).toBe(TENANT);
    expect(payload["provider"]).toBe(CALIBRATE_PROVIDER);
    expect(payload["model"]).toBe(CALIBRATE_MODEL);
    expect(payload["maxTokens"]).toBe(CALIBRATE_MAX_TOKENS);
    expect(payload["document"]).toEqual({ s3Key: S3_KEY });
  });

  // Rides `analyse` on purpose: the collector already treats that kind as
  // "the result IS the artifact", which is exactly what a proposal is. A new
  // kind would mean a migration, a relay deploy and a collector change.
  it("rides kind 'analyse' and marks its purpose in the payload", () => {
    const payload = job({
      pageOneText: null,
    });
    expect(payload["kind"]).toBe("analyse");
    expect(payload["purpose"]).toBe("calibrate");
  });

  // §3.3 — tier 1 matches substrings against THIS extraction, so a hint the
  // model invented from the rendered layout can be accurate about the page and
  // still never match. The page text has to be in the prompt.
  it("shows the model the page-1 text so detect_hint can be copied from it", () => {
    const payload = job({
      pageOneText: "TOYSMITH COMÉRCIO LTDA",
    });
    const prompt = String(payload["prompt"]);
    expect(prompt).toContain("TOYSMITH COMÉRCIO LTDA");
    expect(prompt).toContain("TEM camada de texto");
    expect(prompt).toContain("input_mode deve ser 'text'");
  });

  // §3.1 — input_mode is a COST decision, and the deciding fact was already
  // established locally for free. The model is TOLD, not asked to guess.
  it("tells the model to choose vision when there is no text layer", () => {
    const payload = job({
      pageOneText: null,
    });
    const prompt = String(payload["prompt"]);
    expect(prompt).toContain("NÃO tem camada de texto");
    expect(prompt).toContain("input_mode deve ser 'vision'");
  });

  it("caps the page text it embeds so a long document cannot inflate the prompt", () => {
    const payload = job({
      pageOneText: "x".repeat(PAGE_TEXT_BUDGET * 3),
    });
    expect(String(payload["prompt"]).length).toBeLessThan(PAGE_TEXT_BUDGET + 2_000);
  });

  it("passes the provider and type names through as context when given", () => {
    const payload = job({
      providerName: "Toysmith",
      documentTypeName: "Nota Fiscal",
      pageOneText: null,
    });
    const prompt = String(payload["prompt"]);
    expect(prompt).toContain("Toysmith");
    expect(prompt).toContain("Nota Fiscal");
  });

  it("asks for the three frozen artifacts plus the fixture values", () => {
    const payload = job({
      pageOneText: null,
    });
    const schema = payload["schema"] as Record<string, unknown>;
    expect(schema["required"]).toEqual([
      "document_type_name",
      "input_mode",
      "detect_hint",
      "fields",
      "sample_values_json",
    ]);
  });

  // The relay caps a schema at 64 KiB (relay/src/job.ts MAX_SCHEMA) and
  // refuses the job outright above it — a permanent failure a human would
  // have to diagnose from a settled row.
  it("stays well inside the relay's schema size cap", () => {
    const payload = job({
      pageOneText: null,
    });
    expect(JSON.stringify(payload["schema"]).length).toBeLessThan(65_536);
  });
});

describe("isCalibrateRequest", () => {
  it("recognises a stored calibrate payload and nothing else", () => {
    expect(
      isCalibrateRequest(
        job({
          pageOneText: null,
        }),
      ),
    ).toBe(true);
    expect(isCalibrateRequest({ channel: "ai", kind: "analyse" })).toBe(false);
    expect(isCalibrateRequest(null)).toBe(false);
    expect(isCalibrateRequest("calibrate")).toBe(false);
    expect(isCalibrateRequest([{ purpose: "calibrate" }])).toBe(false);
  });
});

// §12.6 — Calibrate rides the `analyse` kind, so it bills as `analyse`; the
// `calibrate:` segment is what stops its key from ever looking like a report
// analysis's `{templateVersionId}:{extractionIds}`.
describe("§12.6 — the charge binding", () => {
  it("bills as analyse, keyed on the sample document", () => {
    const payload = job({
      pageOneText: null,
    });
    expect(payload["billing"]).toEqual({ source: "analyse", refKey: `calibrate:${S3_KEY}` });
    expect(calibrateRefKey(S3_KEY)).toContain("calibrate:");
  });
});
