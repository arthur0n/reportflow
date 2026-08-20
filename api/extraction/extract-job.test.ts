// api/extraction/extract-job.test.ts
//
// The payload the API hands the relay for hop 1. Two things are actually under
// test here and neither is "does it build an object":
//
//   1. THE COST FORK (§3.1). `text` must not carry a document and `vision`
//      must; getting that backwards is a silent 5–20× bill, or a model asked
//      to read a PDF it was never given.
//   2. THE ONE FROZEN LIST, THREE RENDERINGS. The prompt the model reads and
//      the JSON Schema it is constrained by must both come from the same field
//      list the runtime Zod validator will be built from — that identity is
//      the whole of §3.1, and it is the thing a refactor would break silently.

import { describe, it, expect } from "vitest";
import type { FieldSpec } from "../../shared/validation/field-spec";
import { chargeRefId } from "../billing/charge";
import { PLATFORM_DEFAULTS } from "../services/credentials-service";
import { buildExtractJob, extractionRefKey, readExtractContext } from "./extract-job";

const EXTRACT_PROVIDER = PLATFORM_DEFAULTS.extract.provider;
const EXTRACT_MODEL = PLATFORM_DEFAULTS.extract.model;

const TENANT = "org_2abcTENANT";
const S3_KEY = `${TENANT}/doc.pdf`;
const TEMPLATE_ID = "44444444-4444-4444-8444-444444444444";

const FIELDS: readonly FieldSpec[] = [
  { name: "numero", type: "string", required: true, description: "nº do documento" },
  { name: "iliquido", type: "money", required: true, description: "total ilíquido" },
  {
    name: "itens",
    type: "object[]",
    required: true,
    description: "linhas",
    fields: [{ name: "total", type: "money", required: true, description: "total da linha" }],
  },
];

function base(over: Partial<Parameters<typeof buildExtractJob>[0]> = {}) {
  return {
    tenantId: TENANT,
    s3Key: S3_KEY,
    inputMode: "vision" as const,
    templateId: TEMPLATE_ID,
    calibrationRev: 3,
    fields: FIELDS,
    documentText: null,
    provider: EXTRACT_PROVIDER,
    model: EXTRACT_MODEL,
    ...over,
  };
}

describe("buildExtractJob — the canonical §6 payload", () => {
  it("is an `ai`/`extract` job bound to the caller's own tenant", () => {
    const job = buildExtractJob(base());
    expect(job["channel"]).toBe("ai");
    expect(job["kind"]).toBe("extract");
    expect(job["tenantId"]).toBe(TENANT);
    expect(job["provider"]).toBe(EXTRACT_PROVIDER);
    expect(job["model"]).toBe(EXTRACT_MODEL);
  });

  // The POC's inviolable rule, carried over verbatim: a model that reformats
  // "1.234,56 €" into a float has already lost the cent nothing downstream can
  // recover (§3.1).
  it("tells the model money is returned verbatim", () => {
    expect(String(buildExtractJob(base())["system"])).toContain("VERBATIM");
  });

  it("renders the prompt and the schema from the SAME frozen list", () => {
    const job = buildExtractJob(base());
    const prompt = String(job["prompt"]);
    const schema = job["schema"] as { properties: Record<string, unknown>; required: string[] };

    for (const name of ["numero", "iliquido", "itens", "total"]) {
      expect(prompt).toContain(name);
    }
    expect(Object.keys(schema.properties)).toEqual(["numero", "iliquido", "itens"]);
    expect(schema.required).toEqual(["numero", "iliquido", "itens"]);
  });
});

describe("buildExtractJob — input_mode is a cost decision (§3.1)", () => {
  it("vision sends the PDF by s3Key and no text", () => {
    const job = buildExtractJob(base({ inputMode: "vision" }));
    expect(job["document"]).toEqual({ s3Key: S3_KEY });
    expect(String(job["prompt"])).toContain("PDF anexado");
  });

  // "text mode" MEANS the model gets the extracted text layer INSTEAD of the
  // PDF. A `document` here would make the cheap mode cost the same as the
  // expensive one.
  it("text sends the extracted text and NO document at all", () => {
    const job = buildExtractJob(
      base({ inputMode: "text", documentText: "[página 1]\nTOYSMITH\n[página 2]\ntotal" }),
    );
    expect(job["document"]).toBeUndefined();
    expect(String(job["prompt"])).toContain("TOYSMITH");
    expect(String(job["prompt"])).toContain("[página 2]");
  });

  // §6.1 — citations and structured output cannot be combined, so the page is
  // self-reported. A model can only report one it can see.
  it("text mode points the model at the page markers", () => {
    const job = buildExtractJob(base({ inputMode: "text", documentText: "[página 1]\nx" }));
    expect(String(job["prompt"])).toContain("[página N]");
  });

  it("refuses text mode with no text rather than promoting it to vision", () => {
    expect(() => buildExtractJob(base({ inputMode: "text", documentText: null }))).toThrow();
    expect(() => buildExtractJob(base({ inputMode: "text", documentText: "   " }))).toThrow();
  });

  // An empty list builds `strictObject({})`, which rejects every document —
  // a field list that can never validate is not a field list.
  it("refuses an empty frozen field list", () => {
    expect(() => buildExtractJob(base({ fields: [] }))).toThrow();
  });
});

describe("§12.6 — the charge key", () => {
  // "Model names are not globally unique across providers", which is exactly
  // why the provider is in the key and not just the model.
  it("names provider, model and s3Key", () => {
    expect(chargeRefId("extract", "gemini", "gemini-3.5-flash", extractionRefKey(S3_KEY))).toBe(
      `report_extraction:gemini:gemini-3.5-flash:${S3_KEY}`,
    );
  });

  it("distinguishes the same model name under two providers", () => {
    const key = extractionRefKey(S3_KEY);
    expect(chargeRefId("extract", "a", "m", key)).not.toBe(chargeRefId("extract", "b", "m", key));
  });

  // §7 keys the charge on the ARTIFACT: "re-reading the same PDF must not bill
  // twice, which is exactly what a user does when a read looks wrong". So the
  // retry §4.2 allows must land on the SAME ref_id as the first attempt.
  it("is the same key for every attempt at the same document", () => {
    expect(extractionRefKey(S3_KEY)).toBe(extractionRefKey(S3_KEY));
  });

  // The binding rides the payload so the collector — which never sees the
  // service that built the job — can name the charge without re-deriving it.
  it("rides the job payload", () => {
    expect(buildExtractJob(base())["billing"]).toEqual({
      source: "extract",
      refKey: S3_KEY,
    });
  });

  // §7/§12.7 — BYOK is a parameter NAME on the payload, never a key, and its
  // presence is also how the collector learns that raw = owed = 0.
  it("carries ssmParamName only for BYOK", () => {
    expect(buildExtractJob(base())["ssmParamName"]).toBeUndefined();
    const byok = buildExtractJob(
      base({ ssmParamName: `/reportflow/tenants/${TENANT}/gemini-api-key` }),
    );
    expect(byok["ssmParamName"]).toBe(`/reportflow/tenants/${TENANT}/gemini-api-key`);
  });
});

// ---------------------------------------------------------------------------
// The template binding the job carries, and reads back off
// `report_jobs.request` (codex review, 2026-08-20). Without it the collector
// had to re-read live `extract_fields` rows, which is a race with §12.8: a
// recalibration landing mid-flight would have graded the model's answer
// against a list the model was never shown.
// ---------------------------------------------------------------------------

describe("the template binding — write then read", () => {
  it("carries the template id, the calibration rev and the frozen list", () => {
    const context = readExtractContext(buildExtractJob(base()));
    expect(context).not.toBeNull();
    expect(context?.templateId).toBe(TEMPLATE_ID);
    expect(context?.calibrationRev).toBe(3);
    expect(context?.fields).toEqual(FIELDS);
  });

  // The nested `object[]` subfields have to survive too — they are half the
  // schema, and a reader that flattened them would silently accept a payload
  // whose line items were never checked.
  it("round-trips one level of nesting", () => {
    const context = readExtractContext(buildExtractJob(base()));
    expect(context?.fields[2]?.fields?.map((f) => f.name)).toEqual(["total"]);
  });

  it("survives the jsonb round trip a report_jobs.request makes", () => {
    const stored: unknown = JSON.parse(JSON.stringify(buildExtractJob(base())));
    expect(readExtractContext(stored)?.fields).toEqual(FIELDS);
  });

  // `null` means "the collector cannot grade this", and the collector turns
  // that into `revisar` rather than falling back to a live read.
  it.each([
    ["a payload that is not an object", "não é um job"],
    ["a job with no binding at all", { channel: "ai", kind: "extract" }],
    ["a binding that is not an object", { extractTemplate: "x" }],
    ["a missing template id", { extractTemplate: { calibrationRev: 1, fields: FIELDS } }],
    [
      "a non-integer rev",
      { extractTemplate: { templateId: TEMPLATE_ID, calibrationRev: 1.5, fields: FIELDS } },
    ],
    [
      "an empty field list",
      { extractTemplate: { templateId: TEMPLATE_ID, calibrationRev: 1, fields: [] } },
    ],
    [
      "a field list of the wrong shape",
      { extractTemplate: { templateId: TEMPLATE_ID, calibrationRev: 1, fields: ["total"] } },
    ],
    [
      "a type outside the frozen vocabulary",
      {
        extractTemplate: {
          templateId: TEMPLATE_ID,
          calibrationRev: 1,
          fields: [{ name: "total", type: "currency", required: true, description: "" }],
        },
      },
    ],
    [
      "an empty field name",
      {
        extractTemplate: {
          templateId: TEMPLATE_ID,
          calibrationRev: 1,
          fields: [{ name: "", type: "money", required: true, description: "" }],
        },
      },
    ],
    [
      "a subfield of the wrong shape",
      {
        extractTemplate: {
          templateId: TEMPLATE_ID,
          calibrationRev: 1,
          fields: [
            { name: "itens", type: "object[]", required: true, description: "", fields: [1] },
          ],
        },
      },
    ],
  ])("refuses %s", (_label, request) => {
    expect(readExtractContext(request)).toBeNull();
  });

  // The relay reconstructs an AiJob from the keys it knows and drops the rest
  // (relay/src/job.ts `parseJob`), the same way `purpose` rides an `analyse`
  // job — so the binding costs the relay nothing. Pinned so a future addition
  // to the canonical payload does not quietly collide with it.
  it("rides alongside the canonical keys without replacing any of them", () => {
    const job = buildExtractJob(base());
    for (const key of [
      "channel",
      "kind",
      "tenantId",
      "provider",
      "model",
      "system",
      "prompt",
      "schema",
      "maxTokens",
    ]) {
      expect(job[key]).toBeDefined();
    }
  });
});
