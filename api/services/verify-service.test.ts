// api/services/verify-service.test.ts
//
// §12.13's two hops, and the one rule both obey: THE VERIFIER NEVER REWRITES.
//
// What is asserted here is the INPUT SCOPE of each job — because that is
// exactly what the POC got wrong on its first live pass and what §12.13's own
// amendment then fixed:
//
//   * extraction verify gets the PDF, the extraction JSON, AND the frozen
//     field list (without the spec, every MANDATED normalisation reads as a
//     discrepancy);
//   * analysis verify gets the extraction data AND the code-computed context,
//     and NO PDF (withholding the computed context made it refute four
//     accurate claims, all correct on hand-check);
//   * the verifier's model comes from `resolveModel(…, "verify")`, which is
//     deliberately not the generator's.
//
// And the read side: a settled job row becomes a badge, with "verified and
// clean" distinguishable from "never verified".

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbLike, JobRow } from "../collector/job-state";
import type * as ReportServiceModule from "./report-service";

const service = vi.hoisted(() => ({ loadReportBundle: vi.fn() }));
vi.mock("./report-service", async (importOriginal) => {
  const actual = await importOriginal<typeof ReportServiceModule>();
  return { ...actual, loadReportBundle: service.loadReportBundle };
});

const credentials = vi.hoisted(() => ({
  resolveModel: vi.fn(),
  keyBinding: vi.fn(() => ({})),
}));
vi.mock("./credentials-service", () => credentials);

const store = vi.hoisted(() => ({ loadTemplateFields: vi.fn() }));
vi.mock("../collector/extraction-store", () => store);

const relay = vi.hoisted(() => ({
  jobKeyFor: vi.fn((t: string, j: string) => `jobs/${t}/${j}.json`),
  mintJobId: vi.fn(() => "11111111-1111-4111-8111-111111111111-a1"),
}));
vi.mock("../lib/relay", () => relay);

const { readAnalysisVerify, readExtractionVerify, startVerify } = await import("./verify-service");
const { slotTextHash } = await import("../analysis/verify-job");

const TENANT = "org_2abcTENANT";
const CTX = { tenantId: TENANT, userId: "user-1" };
const REPORT_ID = "44444444-4444-4444-8444-444444444444";
const EXTRACTION_ID = "77777777-7777-4777-8777-777777777777";
const DOC_ID = "88888888-8888-4888-8888-888888888888";
const JOB_ROW_ID = "55555555-5555-4555-8555-555555555555";
const VERSION_ID = "66666666-6666-4666-8666-666666666666";
const S3_KEY = `${TENANT}/doc.pdf`;

const FIELDS = [
  { name: "numero", type: "string" as const, required: true, description: "nº do documento" },
  {
    name: "emissao",
    type: "date" as const,
    required: true,
    description: "data de emissão, SEMPRE em dd/mm/aaaa",
  },
];

const ROLE = {
  key: "faturas",
  documentTypeId: "11111111-1111-4111-8111-111111111111",
  provider: "House Living",
  documentType: "Fatura",
  cardinality: "many" as const,
  required: true,
};

const FATURA = {
  extractionId: "e1",
  documentId: DOC_ID,
  fileName: "f.pdf",
  sortOrder: 0,
  data: { numero: "FT 1", totais: { iliquido: "100,00 €", iva: "23,00 €", documento: "123,00 €" } },
};

function bundle(over: Record<string, unknown> = {}) {
  return {
    report: { id: REPORT_ID, title: "Agosto", frozenAt: null, clientId: null },
    version: { id: VERSION_ID, version: 1, html: "" },
    roles: [ROLE],
    slots: [{ slug: "parecer", guideline: "Resuma o período.", maxWords: 120 }],
    content: { slots: { parecer: { text: "Uma fatura de 123,00 euros.", edited: false } } },
    attached: new Map([[ROLE.key, [FATURA]]]),
    clientName: "House Living",
    ...over,
  };
}

/** `selectQueue` is consumed in order, one array per `select()`. */
function makeDb(selectQueue: unknown[][] = []) {
  const queue = [...selectQueue];
  const select = vi.fn().mockImplementation(() => {
    const rows = queue.shift() ?? [];
    const chain: Record<string, unknown> = {};
    const self = (): Record<string, unknown> => chain;
    Object.assign(chain, {
      from: self,
      innerJoin: self,
      leftJoin: self,
      where: self,
      orderBy: self,
      limit: () => Promise.resolve(rows),
      then: (resolve: (v: unknown) => void) => {
        resolve(rows);
      },
    });
    return chain;
  });
  const returning = vi.fn().mockResolvedValue([{ id: JOB_ROW_ID }]);
  const values = vi.fn().mockReturnValue({ returning });
  const insert = vi.fn().mockReturnValue({ values });
  return { db: { select, insert } as unknown as DbLike, insert, values };
}

const enqueue = vi.fn().mockResolvedValue(undefined);

function payload(): Record<string, unknown> {
  return enqueue.mock.calls[0]?.[2] as Record<string, unknown>;
}

const EXTRACTION_ROW = {
  extractionId: EXTRACTION_ID,
  data: { numero: "FT 1", emissao: "01/08/2026" },
  s3Key: S3_KEY,
  calibrationRev: 3,
  extractTemplateId: "tpl-1",
  documentId: DOC_ID,
  providerName: "House Living",
  typeName: "Fatura",
};

beforeEach(() => {
  vi.clearAllMocks();
  credentials.resolveModel.mockResolvedValue({
    provider: "gemini",
    model: "gemini-3.1-pro-preview",
    byok: null,
  });
  credentials.keyBinding.mockReturnValue({});
  store.loadTemplateFields.mockResolvedValue(FIELDS);
  enqueue.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------

describe("startVerify — extraction (§12.13, hop A)", () => {
  it("sends the PDF, the extracted JSON, and the frozen field spec", async () => {
    // extraction row, then the in-flight check.
    const { db } = makeDb([[EXTRACTION_ROW], []]);
    await expect(
      startVerify({ db, enqueue }, CTX, { target: "extraction", extractionId: EXTRACTION_ID }),
    ).resolves.toEqual({ jobId: JOB_ROW_ID, target: "extraction" });

    expect(payload()["kind"]).toBe("verify");
    expect(payload()["document"]).toEqual({ s3Key: S3_KEY });
    const prompt = String(payload()["prompt"]);
    // Without the spec, "SEMPRE em dd/mm/aaaa" reads as a discrepancy — the
    // exact noise the POC's first pass drowned in.
    expect(prompt).toContain("dd/mm/aaaa");
    expect(prompt).toContain("Dados extraídos por OUTRO modelo");
  });

  it("tells the model to refute, not to confirm", async () => {
    const { db } = makeDb([[EXTRACTION_ROW], []]);
    await startVerify({ db, enqueue }, CTX, { target: "extraction", extractionId: EXTRACTION_ID });
    expect(String(payload()["system"])).toContain("REFUTÁ-LA");
    expect(String(payload()["system"])).toContain("Nunca corrija o valor você mesmo");
  });

  // §12.6 — keyed on the artifact under audit, so re-verifying the same
  // extraction at the same calibration generation bills once.
  it("keys the charge on the document and its calibration rev", async () => {
    const { db } = makeDb([[EXTRACTION_ROW], []]);
    await startVerify({ db, enqueue }, CTX, { target: "extraction", extractionId: EXTRACTION_ID });
    expect(payload()["billing"]).toEqual({
      source: "verify",
      refKey: `extraction:${S3_KEY}:3`,
    });
  });

  it("refuses an extraction that is not this tenant's", async () => {
    const { db } = makeDb([[]]);
    await expect(
      startVerify({ db, enqueue }, CTX, { target: "extraction", extractionId: EXTRACTION_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("reuses an in-flight verify rather than buying a second one", async () => {
    const { db } = makeDb([[EXTRACTION_ROW], [{ id: "in-flight" }]]);
    await expect(
      startVerify({ db, enqueue }, CTX, { target: "extraction", extractionId: EXTRACTION_ID }),
    ).resolves.toEqual({ jobId: "in-flight", target: "extraction" });
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("startVerify — analysis (§12.13, hop B + its POC amendment)", () => {
  it("sends the prose, the extraction data AND the code-computed context", async () => {
    service.loadReportBundle.mockResolvedValue(bundle());
    const { db } = makeDb([[]]);
    await expect(
      startVerify({ db, enqueue }, CTX, { target: "analysis", reportId: REPORT_ID }),
    ).resolves.toEqual({ jobId: JOB_ROW_ID, target: "analysis" });

    const prompt = String(payload()["prompt"]);
    expect(prompt).toContain("DADOS DE EXTRAÇÃO");
    // The amendment. Withholding this made the verifier refute four accurate
    // claims it simply had not been shown.
    expect(prompt).toContain("CONTEXTO CALCULADO EM CÓDIGO");
    expect(prompt).toContain('"documento_cents": 12300');
    expect(prompt).toContain("TEXTO A AUDITAR");
  });

  // §12.3's guarantee, held a second time — expressed as an absence.
  it("attaches NO PDF", async () => {
    service.loadReportBundle.mockResolvedValue(bundle());
    const { db } = makeDb([[]]);
    await startVerify({ db, enqueue }, CTX, { target: "analysis", reportId: REPORT_ID });
    expect(payload()["document"]).toBeUndefined();
  });

  it("refuses when there is no prose to audit yet", async () => {
    service.loadReportBundle.mockResolvedValue(bundle({ content: { slots: {} } }));
    const { db } = makeDb([[]]);
    await expect(
      startVerify({ db, enqueue }, CTX, { target: "analysis", reportId: REPORT_ID }),
    ).rejects.toThrow(/Gere a análise primeiro/u);
    expect(enqueue).not.toHaveBeenCalled();
  });

  // §12.13 — a verdict is a claim about a SPECIFIC piece of prose, and ~60s
  // pass before it lands. The digest is what lets the collector tell "this
  // verdict is about the text that is there now" from "somebody rewrote it".
  it("binds the job to a digest of the exact prose it sent", async () => {
    service.loadReportBundle.mockResolvedValue(bundle());
    const { db } = makeDb([[]]);
    await startVerify({ db, enqueue }, CTX, { target: "analysis", reportId: REPORT_ID });

    const context = payload()["reportVerify"] as { textHashes: Record<string, string> };
    expect(context.textHashes["parecer"]).toBe(slotTextHash("Uma fatura de 123,00 euros."));
    // The keys ARE the slug list — one fact, not two that can drift.
    expect(Object.keys(context.textHashes)).toEqual(["parecer"]);
  });

  it("uses the verify hop's own model resolution, not the writer's", async () => {
    service.loadReportBundle.mockResolvedValue(bundle());
    const { db } = makeDb([[]]);
    await startVerify({ db, enqueue }, CTX, { target: "analysis", reportId: REPORT_ID });
    expect(credentials.resolveModel).toHaveBeenCalledWith(expect.anything(), TENANT, "verify");
  });
});

// ---------------------------------------------------------------------------
// The read side — badges
// ---------------------------------------------------------------------------

function job(over: Partial<JobRow>): JobRow {
  return {
    id: JOB_ROW_ID,
    status: "done",
    error: null,
    result: null,
    lastUpdAt: "2026-08-20T10:00:00.000Z",
    ...over,
  } as JobRow;
}

function envelope(payloadJson: unknown) {
  return { content: JSON.stringify(payloadJson), provider: "gemini", model: "m", usage: {} };
}

describe("reading verdicts back", () => {
  it("says 'nenhum' when nothing has ever verified this", () => {
    expect(readExtractionVerify(undefined).view).toEqual({ state: "nenhum" });
  });

  it("tallies a settled extraction pass and hands back the refuted fields", () => {
    const row = job({
      result: envelope({
        verdicts: [
          { field: "numero", verdict: "confirmado", valor_documento: null },
          { field: "emissao", verdict: "refutado", valor_documento: "02/08/2026" },
          { field: "totais.iva", verdict: "ilegivel", valor_documento: null },
        ],
      }),
    });
    const out = readExtractionVerify(row);
    expect(out.view).toMatchObject({
      state: "pronto",
      tally: { total: 3, confirmado: 1, refutado: 1, ilegivel: 1 },
    });
    expect(out.verdicts[1]).toMatchObject({ field: "emissao", valor_documento: "02/08/2026" });
  });

  // The money is spent either way; only this one is worth re-running.
  it("distinguishes an unreadable answer from a failed hop", () => {
    expect(readExtractionVerify(job({ result: envelope({ nope: 1 }) })).view).toEqual({
      state: "ilegivel",
    });
    expect(readExtractionVerify(job({ status: "failed", error: "429" })).view).toMatchObject({
      state: "falhou",
    });
  });

  it("reports a pass still in flight", () => {
    expect(readAnalysisVerify(job({ status: "pending" })).view).toEqual({ state: "executando" });
  });

  it("tallies a settled analysis pass", () => {
    const row = job({
      result: envelope({
        verdicts: [
          { slot: "parecer", claim: "123,00", verdict: "confirmado", fundamento: null },
          { slot: "parecer", claim: "999,99", verdict: "refutado", fundamento: "sem fonte" },
        ],
      }),
    });
    expect(readAnalysisVerify(row).view).toMatchObject({
      state: "pronto",
      tally: { total: 2, refutado: 1 },
    });
  });
});
