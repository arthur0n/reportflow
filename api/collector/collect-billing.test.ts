// api/collector/collect-billing.test.ts
//
// THE CHARGE WIRING (§7, §12.6) and the two results that are not
// self-contained artifacts (§5.2 prose, §12.13 verdicts). Split from
// collect.test.ts, which is about §4.2's retry fork; this file is about what
// happens on the way to `done`.
//
// The properties that matter, in the order they cost money:
//
//   1. EVERY successful hop writes a charge — detect, extract, analyse, verify
//      — with the provider and model THAT RAN (from the result), and the
//      artifact key the job was built with (from the stored request).
//   2. A FAILED hop writes NONE. The relay classified it; nobody was billed
//      for a call that did not answer.
//   3. AN UNPRICED PLATFORM-KEY MODEL SETTLES THE JOB TERMINAL rather than
//      leaving it `pending`. §7 would rather leave the artifact uncollected
//      than accept it for free — but a throw here is the `pending`-forever
//      failure the collector exists to prevent.
//   4. THE CHARGE IS WRITTEN BEFORE THE ARTIFACT AND THE STATUS. Idempotent on
//      `ref_id`, so a redelivery is free; the reverse order lets a crash bill
//      zero for work that is already stored.
//   5. `analyse` ROUTES BY PURPOSE. A Calibrate proposal on the same kind must
//      not be merged into anybody's draft.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type * as JobStateModule from "./job-state";
import type * as ChargeModule from "../billing/charge";
import type * as ContentStoreModule from "./report-content-store";

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    public readonly send = vi.fn();
  },
  GetObjectCommand: class {
    public constructor(public readonly input: unknown) {}
  },
  PutObjectCommand: class {
    public constructor(public readonly input: unknown) {}
  },
}));

const state = vi.hoisted(() => ({
  transition: vi.fn(),
  casAttempt: vi.fn(),
  confirmEnqueue: vi.fn(),
  loadJobByS3Key: vi.fn(),
}));
vi.mock("./job-state", async (importOriginal) => {
  const actual = await importOriginal<typeof JobStateModule>();
  return {
    ...state,
    MAX_ATTEMPTS: 2,
    ENQUEUE_PENDING_MARKER: actual.ENQUEUE_PENDING_MARKER,
    isAwaitingEnqueue: actual.isAwaitingEnqueue,
  };
});

const store = vi.hoisted(() => ({
  resolveExtractionTarget: vi.fn(),
  insertExtractionIdempotent: vi.fn(),
}));
vi.mock("./extraction-store", () => store);

const content = vi.hoisted(() => ({
  mergeAnalysisSlots: vi.fn(),
  applyAnalysisVerdicts: vi.fn(),
}));
// Only the two WRITES are stubbed — their SQL is proven in
// report-content-store.test.ts. The constants are the real ones, because
// collect.ts composes the operator note out of them.
vi.mock("./report-content-store", async (importOriginal) => {
  const actual = await importOriginal<typeof ContentStoreModule>();
  return { ...actual, ...content };
});

// `writeCharge` is the ONE thing stubbed on the billing side — its arithmetic
// is proven in api/billing/charge.test.ts. `chargeRefId`, `readBillingBinding`
// and `readByok` are the REAL ones: they are the wiring under test.
const billing = vi.hoisted(() => ({ writeCharge: vi.fn() }));
vi.mock("../billing/charge", async (importOriginal) => {
  const actual = await importOriginal<typeof ChargeModule>();
  return { ...actual, writeCharge: billing.writeCharge };
});

const { collectResult } = await import("./collect");
const { UnpricedModelError } = await import("../billing/charge");

const TENANT = "org_2abcTENANT";
const BASE = "3f2b1c8e-5a4d-4e6f-8a9b-0c1d2e3f4a5b";
const JOB_A1 = `${BASE}-a1`;
const ROW_ID = "11111111-1111-4111-8111-111111111111";
const DOC_ID = "22222222-2222-4222-8222-222222222222";
const TEMPLATE_ID = "33333333-3333-4333-8333-333333333333";
const REPORT_ID = "44444444-4444-4444-8444-444444444444";
const VERSION_ID = "66666666-6666-4666-8666-666666666666";
const S3_KEY = `${TENANT}/doc.pdf`;

const FIELDS = [{ name: "total", type: "integer", required: true, description: "total" }];

function success(content_: string, over: Record<string, unknown> = {}) {
  return {
    content: content_,
    usage: { input_tokens: 1_000, output_tokens: 500 },
    model: "gemini-3.5-flash",
    provider: "gemini",
    ...over,
  };
}

function jobRow(over: Record<string, unknown> = {}) {
  return {
    id: ROW_ID,
    tenantId: TENANT,
    kind: "extract",
    status: "pending",
    s3Key: `jobs/${TENANT}/${JOB_A1}.json`,
    attempt: 1,
    error: null,
    request: {
      channel: "ai",
      kind: "extract",
      tenantId: TENANT,
      billing: { source: "extract", refKey: S3_KEY },
      extractTemplate: { templateId: TEMPLATE_ID, calibrationRev: 1, fields: FIELDS },
    },
    result: null,
    documentId: DOC_ID,
    reportId: null,
    ...over,
  };
}

const deps = { db: {} as never, enqueue: vi.fn() };

function collect(result: unknown) {
  return collectResult(deps, { tenantId: TENANT, jobId: JOB_A1, result });
}

function charged(): Record<string, unknown> {
  return billing.writeCharge.mock.calls[0]?.[1] as Record<string, unknown>;
}

function transitionedTo(): string | undefined {
  return (state.transition.mock.calls[0]?.[1] as { to?: string } | undefined)?.to;
}

function transitionError(): string | null | undefined {
  return (state.transition.mock.calls[0]?.[1] as { patch?: { error?: string | null } } | undefined)
    ?.patch?.error;
}

beforeEach(() => {
  state.transition.mockReset().mockResolvedValue(true);
  state.casAttempt.mockReset().mockResolvedValue(true);
  state.confirmEnqueue.mockReset().mockResolvedValue(true);
  state.loadJobByS3Key.mockReset().mockResolvedValue(jobRow());
  store.resolveExtractionTarget.mockReset().mockResolvedValue({
    documentId: DOC_ID,
    extractTemplateId: TEMPLATE_ID,
    s3Key: S3_KEY,
    calibrationRev: 1,
  });
  store.insertExtractionIdempotent.mockReset().mockResolvedValue({ created: true });
  content.mergeAnalysisSlots.mockReset().mockResolvedValue({
    ok: true,
    merged: ["parecer"],
    preserved: [],
    rejected: [],
    obsolete: [],
  });
  content.applyAnalysisVerdicts.mockReset().mockResolvedValue({
    ok: true,
    merged: [],
    preserved: [],
    rejected: [],
    obsolete: [],
  });
  billing.writeCharge.mockReset().mockResolvedValue({ written: true });
  deps.enqueue.mockReset().mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------

describe("the charge, per kind (§12.6)", () => {
  it("bills an extraction on the S3 key, with the provider that RAN", async () => {
    await collect(success('{"total":10}'));
    expect(charged()).toMatchObject({
      refId: `report_extraction:gemini:gemini-3.5-flash:${S3_KEY}`,
      source: "extract",
      tenantId: TENANT,
      usage: { input_tokens: 1_000, output_tokens: 500 },
      byok: false,
    });
  });

  it("bills a detection on the document", async () => {
    state.loadJobByS3Key.mockResolvedValue(
      jobRow({ kind: "detect", request: { billing: { source: "detect", refKey: S3_KEY } } }),
    );
    await collect(success('{"tipo":"x"}'));
    expect(charged()).toMatchObject({
      refId: `report_detect:gemini:gemini-3.5-flash:${S3_KEY}`,
      source: "detect",
    });
  });

  it("bills a report analysis on the version and its extractions", async () => {
    state.loadJobByS3Key.mockResolvedValue(analyseRow());
    await collect(success('{"parecer":"texto"}'));
    expect(charged()).toMatchObject({
      refId: `report_analysis:gemini:gemini-3.5-flash:${VERSION_ID}:e1`,
      source: "analyse",
    });
  });

  it("bills a verify pass on the artifact it audited", async () => {
    state.loadJobByS3Key.mockResolvedValue(
      jobRow({
        kind: "verify",
        request: { billing: { source: "verify", refKey: `extraction:${S3_KEY}:1` } },
      }),
    );
    await collect(
      success('{"verdicts":[{"field":"total","verdict":"confirmado","valor_documento":null}]}'),
    );
    expect(charged()).toMatchObject({
      refId: `report_verify:gemini:gemini-3.5-flash:extraction:${S3_KEY}:1`,
      source: "verify",
    });
  });

  // The payload says what was ASKED for; the result says what RAN. When they
  // differ — a dated alias, a relay fallback — only one of them is billable.
  it("bills the model from the RESULT, not from the request", async () => {
    await collect(success('{"total":10}', { model: "gemini-2.5-flash" }));
    expect(charged()).toMatchObject({ model: "gemini-2.5-flash" });
    expect(String(charged()["refId"])).toContain("gemini-2.5-flash");
  });

  // ONE fact, ONE field — the same `ssmParamName` the relay reads to decide
  // whose key to fetch.
  it("reads BYOK off the job payload's ssmParamName", async () => {
    state.loadJobByS3Key.mockResolvedValue(
      jobRow({
        request: {
          ...jobRow().request,
          ssmParamName: `/reportflow/tenants/${TENANT}/gemini-api-key`,
        },
      }),
    );
    await collect(success('{"total":10}'));
    expect(charged()).toMatchObject({ byok: true });
  });
});

describe("when a charge is NOT written", () => {
  it("bills nothing for a classified relay failure", async () => {
    state.loadJobByS3Key.mockResolvedValue(jobRow({ attempt: 2 }));
    await collectResult(deps, {
      tenantId: TENANT,
      jobId: `${BASE}-a2`,
      result: { error: { type: "permanent", message: "unknown provider" } },
    });
    expect(billing.writeCharge).not.toHaveBeenCalled();
  });

  // A job from before #10, or a hand-edited payload. Nobody can bill it — and
  // refusing to settle would trade an unbilled hop for a row that is `pending`
  // forever, which is the failure this whole file exists to prevent.
  it("settles a job with no billing binding rather than wedging it", async () => {
    state.loadJobByS3Key.mockResolvedValue(
      jobRow({
        request: {
          extractTemplate: { templateId: TEMPLATE_ID, calibrationRev: 1, fields: FIELDS },
        },
      }),
    );
    await expect(collect(success('{"total":10}'))).resolves.toMatchObject({ action: "settled" });
    expect(billing.writeCharge).not.toHaveBeenCalled();
    expect(transitionedTo()).toBe("done");
  });
});

describe("§7's fail-closed refusal, at the ledger", () => {
  // Reached only when a price row is REMOVED between enqueue and collect —
  // `resolveModel` already refuses to START such a hop. It is the invariant,
  // so it is checked where the row is written.
  it("stores NOTHING and settles the job terminal, without throwing", async () => {
    billing.writeCharge.mockRejectedValue(new UnpricedModelError("gemini", "gemini-4-ultra"));
    await expect(collect(success('{"total":10}'))).resolves.toMatchObject({ action: "settled" });
    expect(store.insertExtractionIdempotent).not.toHaveBeenCalled();
    // `revisar` for an extract — a human can see it (§4.2).
    expect(transitionedTo()).toBe("revisar");
    expect(String(transitionError())).toContain("sem preço configurado");
  });

  it("does not swallow an unrelated database error", async () => {
    billing.writeCharge.mockRejectedValue(new Error("connection reset"));
    await expect(collect(success('{"total":10}'))).rejects.toThrow(/connection reset/u);
  });
});

describe("order of writes", () => {
  // CHARGE, then ARTIFACT, then STATUS. Every earlier step is idempotent on
  // its own key, so a crash anywhere leaves the row `pending` and the next
  // delivery re-runs the whole path for free.
  it("writes the charge before the extraction and the extraction before the status", async () => {
    const order: string[] = [];
    billing.writeCharge.mockImplementation(async () => {
      order.push("charge");
      return Promise.resolve({ written: true });
    });
    store.insertExtractionIdempotent.mockImplementation(async () => {
      order.push("extraction");
      return Promise.resolve({ created: true });
    });
    state.transition.mockImplementation(async () => {
      order.push("status");
      return Promise.resolve(true);
    });

    await collect(success('{"total":10}'));
    expect(order).toEqual(["charge", "extraction", "status"]);
  });
});

// ---------------------------------------------------------------------------
// analyse + verify routing
// ---------------------------------------------------------------------------

function analyseRow(over: Record<string, unknown> = {}) {
  return jobRow({
    kind: "analyse",
    documentId: null,
    reportId: REPORT_ID,
    request: {
      channel: "ai",
      kind: "analyse",
      purpose: "report",
      billing: { source: "analyse", refKey: `${VERSION_ID}:e1` },
      reportAnalysis: {
        reportId: REPORT_ID,
        templateVersionId: VERSION_ID,
        slugs: ["parecer"],
        forced: [],
        extractionIds: ["e1"],
      },
    },
    ...over,
  });
}

describe("analyse results (§5.2)", () => {
  it("merges the prose into the draft and flips the job to done", async () => {
    state.loadJobByS3Key.mockResolvedValue(analyseRow());
    await collect(success('{"parecer":"texto"}'));
    expect(content.mergeAnalysisSlots).toHaveBeenCalledWith(
      {},
      TENANT,
      expect.objectContaining({ reportId: REPORT_ID, slugs: ["parecer"] }),
      { parecer: "texto" },
    );
    expect(transitionedTo()).toBe("done");
  });

  // §5.2's whole point, surfaced where a person can see it happened.
  it("records the preserved slugs on the settled job", async () => {
    state.loadJobByS3Key.mockResolvedValue(analyseRow());
    content.mergeAnalysisSlots.mockResolvedValue({
      ok: true,
      merged: ["parecer"],
      preserved: ["riscos"],
      rejected: [],
      obsolete: [],
    });
    await collect(success('{"parecer":"texto"}'));
    expect(String(transitionError())).toContain("riscos");
  });

  // A Calibrate proposal rides the SAME kind (api/calibration/propose-job.ts).
  // Merging one into a draft would write a field-list JSON into somebody's
  // prose.
  it("does NOT merge a Calibrate proposal", async () => {
    state.loadJobByS3Key.mockResolvedValue(
      jobRow({
        kind: "analyse",
        request: {
          purpose: "calibrate",
          billing: { source: "analyse", refKey: `calibrate:${S3_KEY}` },
        },
      }),
    );
    await collect(success('{"fields":[]}'));
    expect(content.mergeAnalysisSlots).not.toHaveBeenCalled();
    expect(transitionedTo()).toBe("done");
    // It is still BILLED — it ran.
    expect(charged()).toMatchObject({ source: "analyse" });
  });

  it("fails the job when the draft moved to another template version", async () => {
    state.loadJobByS3Key.mockResolvedValue(analyseRow());
    content.mergeAnalysisSlots.mockResolvedValue({ ok: false, reason: "modelo atualizado" });
    await collect(success('{"parecer":"texto"}'));
    expect(transitionedTo()).toBe("failed");
  });

  // "Nothing was written, so `done` would be a lie." §4.2's one retry, spent
  // on what is most likely a transient formatting failure.
  it("retries once when the answer has no usable slot at all", async () => {
    state.loadJobByS3Key.mockResolvedValue(analyseRow());
    content.mergeAnalysisSlots.mockResolvedValue({
      ok: true,
      merged: [],
      preserved: [],
      rejected: ["parecer"],
      obsolete: [],
    });
    await expect(collect(success('{"parecer":"x"}'))).resolves.toMatchObject({ action: "retried" });
  });
});

describe("verify results (§12.13)", () => {
  function verifyRow(target: Record<string, unknown>) {
    return jobRow({
      kind: "verify",
      reportId: REPORT_ID,
      request: {
        billing: { source: "verify", refKey: "k" },
        reportVerify: target,
      },
    });
  }

  it("writes an analysis verifier's refutations onto the slots it judged", async () => {
    state.loadJobByS3Key.mockResolvedValue(
      verifyRow({
        target: "analysis",
        reportId: REPORT_ID,
        templateVersionId: VERSION_ID,
        // §12.13 — a verdict is bound to the prose it judged, by digest.
        textHashes: { parecer: "a".repeat(64) },
      }),
    );
    content.applyAnalysisVerdicts.mockResolvedValue({
      ok: true,
      merged: ["parecer"],
      preserved: [],
      rejected: [],
      obsolete: [],
    });

    await collect(
      success(
        '{"verdicts":[{"slot":"parecer","claim":"999,99","verdict":"refutado","fundamento":"sem fonte"}]}',
      ),
    );
    expect(content.applyAnalysisVerdicts).toHaveBeenCalled();
    expect(transitionedTo()).toBe("done");
    expect(String(transitionError())).toContain("contestado: parecer");
  });

  // THE VERIFIER NEVER REWRITES. An extraction verdict is the job row and
  // nothing else — no write to `extractions`, no write to a draft.
  it("stores an extraction verdict as the job result and touches nothing else", async () => {
    state.loadJobByS3Key.mockResolvedValue(
      verifyRow({ target: "extraction", extractionId: "e1", documentId: DOC_ID }),
    );
    await collect(
      success('{"verdicts":[{"field":"total","verdict":"refutado","valor_documento":"11"}]}'),
    );
    expect(store.insertExtractionIdempotent).not.toHaveBeenCalled();
    expect(content.applyAnalysisVerdicts).not.toHaveBeenCalled();
    expect(transitionedTo()).toBe("done");
  });

  // The hop ran and was billed; a second identical call is `permanent` in
  // everything but name, and the answer is still in the bucket.
  it("fails rather than retrying when the verdict list is unreadable", async () => {
    state.loadJobByS3Key.mockResolvedValue(
      verifyRow({ target: "extraction", extractionId: "e1", documentId: DOC_ID }),
    );
    await collect(success('{"nope":1}'));
    expect(transitionedTo()).toBe("failed");
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  // A verdict silently dropped is indistinguishable from a clean pass, and
  // "verifique novamente" is not discoverable from a badge that says nothing.
  it("names the obsolete slots on the settled job", async () => {
    state.loadJobByS3Key.mockResolvedValue(
      verifyRow({
        target: "analysis",
        reportId: REPORT_ID,
        templateVersionId: VERSION_ID,
        textHashes: { parecer: "a".repeat(64) },
      }),
    );
    content.applyAnalysisVerdicts.mockResolvedValue({
      ok: true,
      merged: [],
      preserved: [],
      rejected: [],
      obsolete: ["parecer"],
    });
    await collect(
      success(
        '{"verdicts":[{"slot":"parecer","claim":"x","verdict":"refutado","fundamento":"y"}]}',
      ),
    );
    expect(transitionedTo()).toBe("done");
    expect(String(transitionError())).toContain("veredicto obsoleto");
  });
});
