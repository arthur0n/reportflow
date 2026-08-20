// api/services/analysis-service.test.ts
//
// Hop 2's orchestration. What is under test is WHICH SLOTS a press of the
// button buys, and when it refuses to buy anything at all:
//
//   * §3.2 — a required role with no document REFUSES. The model would happily
//     write prose about documents that are not there.
//   * §5.2 — an edited slot is skipped by DEFAULT, and naming it explicitly is
//     the "regerar mesmo assim" override. Getting this backwards silently eats
//     human prose, which is the bug §5.2 exists to prevent.
//   * §12.12b — the model is handed the code-computed context as FACTS.
//   * §12.6 — the ref_id is `{templateVersionId}:{sortedExtractionIds}`, so two
//     racing callers converge on ONE charge.
//
// `loadReportBundle` is mocked (proven in report-service.test.ts) but
// `reportContextOf` is NOT: it is what decides the role gate and the facts,
// and a stub would be the thing under test answering for itself.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbLike } from "../collector/job-state";
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

const relay = vi.hoisted(() => ({
  jobKeyFor: vi.fn((t: string, j: string) => `jobs/${t}/${j}.json`),
  mintJobId: vi.fn(() => "11111111-1111-4111-8111-111111111111-a1"),
}));
vi.mock("../lib/relay", () => relay);

const { startAnalysis, selectSlots } = await import("./analysis-service");
const { analysisRefKey } = await import("../analysis/analyse-job");

const TENANT = "org_2abcTENANT";
const CTX = { tenantId: TENANT, userId: "user-1" };
const REPORT_ID = "44444444-4444-4444-8444-444444444444";
const JOB_ROW_ID = "55555555-5555-4555-8555-555555555555";
const VERSION_ID = "66666666-6666-4666-8666-666666666666";

const ROLE = {
  key: "faturas",
  documentTypeId: "11111111-1111-4111-8111-111111111111",
  provider: "House Living",
  documentType: "Fatura",
  cardinality: "many" as const,
  required: true,
};

const SLOTS = [
  { slug: "parecer", guideline: "Resuma o período.", maxWords: 120 },
  { slug: "riscos", guideline: "Aponte riscos.", maxWords: 80 },
];

const FATURA = {
  extractionId: "e1",
  documentId: "d1",
  fileName: "f.pdf",
  sortOrder: 0,
  data: { numero: "FT 1", totais: { iliquido: "100,00 €", iva: "23,00 €", documento: "123,00 €" } },
};

function bundle(over: Record<string, unknown> = {}) {
  return {
    report: { id: REPORT_ID, title: "Agosto", frozenAt: null, clientId: null },
    version: { id: VERSION_ID, version: 1, html: '<p>{{ai "parecer"}}</p>' },
    roles: [ROLE],
    slots: SLOTS,
    content: { slots: {} },
    attached: new Map([[ROLE.key, [FATURA]]]),
    clientName: "House Living",
    ...over,
  };
}

function makeDb(insertReturning: unknown[] = [{ id: JOB_ROW_ID }]) {
  const returning = vi.fn().mockResolvedValue(insertReturning);
  const values = vi.fn().mockReturnValue({ returning });
  const insert = vi.fn().mockReturnValue({ values });
  const select = vi.fn().mockReturnValue({
    from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
  });
  return { db: { insert, select } as unknown as DbLike, values, insert };
}

const enqueue = vi.fn().mockResolvedValue(undefined);

beforeEach(() => {
  vi.clearAllMocks();
  credentials.resolveModel.mockResolvedValue({
    provider: "gemini",
    model: "gemini-3.5-flash-lite",
    byok: null,
  });
  credentials.keyBinding.mockReturnValue({});
  enqueue.mockResolvedValue(undefined);
});

function payload(): Record<string, unknown> {
  return enqueue.mock.calls[0]?.[2] as Record<string, unknown>;
}

// ---------------------------------------------------------------------------

describe("selectSlots — §5.2's whole rule, in one function", () => {
  it("defaults to every slot a human has not edited", () => {
    const b = bundle({
      content: { slots: { riscos: { text: "meu texto", edited: true } } },
    }) as unknown as ReportServiceModule.ReportBundle;
    expect(selectSlots(b, undefined).slots.map((s) => s.slug)).toEqual(["parecer"]);
  });

  // Naming a slot IS "regerar mesmo assim". There is deliberately no separate
  // boolean, because a flag can be set for slots the caller never looked at.
  it("naming an edited slot forces it, and says so", () => {
    const b = bundle({
      content: { slots: { riscos: { text: "meu texto", edited: true } } },
    }) as unknown as ReportServiceModule.ReportBundle;
    const picked = selectSlots(b, ["riscos"]);
    expect(picked.slots.map((s) => s.slug)).toEqual(["riscos"]);
    expect(picked.forced).toEqual(["riscos"]);
  });

  it("a named slot nobody edited is not reported as forced", () => {
    const b = bundle() as unknown as ReportServiceModule.ReportBundle;
    expect(selectSlots(b, ["parecer"]).forced).toEqual([]);
  });
});

describe("startAnalysis — the gates", () => {
  // §3.2. A "showable waiting state" everywhere else; here it is a refusal,
  // because this is a request to SPEND on documents that are not there.
  it("refuses while a required role is empty, naming the role", async () => {
    service.loadReportBundle.mockResolvedValue(bundle({ attached: new Map() }));
    const { db } = makeDb();
    await expect(startAnalysis({ db, enqueue }, CTX, { reportId: REPORT_ID })).rejects.toThrow(
      /aguardando documento para: faturas/iu,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses on a published report (§5.1)", async () => {
    service.loadReportBundle.mockResolvedValue(
      bundle({
        report: { id: REPORT_ID, title: null, frozenAt: "2026-08-20T00:00:00Z", clientId: null },
      }),
    );
    const { db } = makeDb();
    await expect(
      startAnalysis({ db, enqueue }, CTX, { reportId: REPORT_ID }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("refuses a slug this version does not declare", async () => {
    service.loadReportBundle.mockResolvedValue(bundle());
    const { db } = makeDb();
    await expect(
      startAnalysis({ db, enqueue }, CTX, { reportId: REPORT_ID, slugs: ["inventado"] }),
    ).rejects.toThrow(/inexistente/iu);
    expect(enqueue).not.toHaveBeenCalled();
  });

  // The alternative is a paid hop whose whole result the §5.2 guard discards.
  it("refuses when every slot is edited and none was named", async () => {
    service.loadReportBundle.mockResolvedValue(
      bundle({
        content: {
          slots: {
            parecer: { text: "a", edited: true },
            riscos: { text: "b", edited: true },
          },
        },
      }),
    );
    const { db } = makeDb();
    await expect(startAnalysis({ db, enqueue }, CTX, { reportId: REPORT_ID })).rejects.toThrow(
      /regerar mesmo assim/iu,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });
});

describe("startAnalysis — the job it buys", () => {
  it("enqueues ONE job for every pending slot (§9 — no fan-out)", async () => {
    service.loadReportBundle.mockResolvedValue(bundle());
    const { db } = makeDb();

    await expect(startAnalysis({ db, enqueue }, CTX, { reportId: REPORT_ID })).resolves.toEqual({
      jobId: JOB_ROW_ID,
      slugs: ["parecer", "riscos"],
      forced: [],
    });
    expect(enqueue).toHaveBeenCalledOnce();
    expect(payload()["kind"]).toBe("analyse");
    expect(payload()["purpose"]).toBe("report");
  });

  // §12.3, expressed as an absence: hop 2 reads stored extractions, never a
  // PDF, and there is no code path here that could attach one.
  it("carries no document and hands the model the computed facts (§12.3, §12.12b)", async () => {
    service.loadReportBundle.mockResolvedValue(bundle());
    const { db } = makeDb();
    await startAnalysis({ db, enqueue }, CTX, { reportId: REPORT_ID });

    expect(payload()["document"]).toBeUndefined();
    const prompt = String(payload()["prompt"]);
    expect(prompt).toContain("FACTOS APURADOS");
    // The code-computed aggregate: 100,00 + 23,00 = 123,00, in integer cents.
    expect(prompt).toContain('"documento_cents": 12300');
    expect(prompt).toContain("não recalcule nada");
  });

  // §12.6 — keyed on the ARTIFACT (this version's prose about exactly these
  // extractions), which is what makes two racing callers converge on ONE
  // charge and what makes a regeneration free.
  it("keys the charge on the template version and the bound extractions", async () => {
    service.loadReportBundle.mockResolvedValue(bundle());
    const { db } = makeDb();
    await startAnalysis({ db, enqueue }, CTX, { reportId: REPORT_ID });

    expect(payload()["billing"]).toEqual({
      source: "analyse",
      refKey: analysisRefKey(VERSION_ID, ["e1"]),
    });
  });

  it("uses the same charge key whether one slot or all of them are regenerated", async () => {
    service.loadReportBundle.mockResolvedValue(bundle());
    const { db } = makeDb();
    await startAnalysis({ db, enqueue }, CTX, { reportId: REPORT_ID });
    const all = payload()["billing"];

    enqueue.mockClear();
    service.loadReportBundle.mockResolvedValue(bundle());
    await startAnalysis({ db: makeDb().db, enqueue }, CTX, {
      reportId: REPORT_ID,
      slugs: ["parecer"],
    });
    expect(payload()["billing"]).toEqual(all);
  });

  // The collector re-applies §5.2 when the answer lands ~30s later, against a
  // draft a human may have edited in between — so the job has to carry what
  // was decided here.
  it("carries the slug set AND the forced subset into the payload", async () => {
    service.loadReportBundle.mockResolvedValue(
      bundle({ content: { slots: { riscos: { text: "meu", edited: true } } } }),
    );
    const { db } = makeDb();
    await startAnalysis({ db, enqueue }, CTX, { reportId: REPORT_ID, slugs: ["riscos"] });

    expect(payload()["reportAnalysis"]).toMatchObject({
      reportId: REPORT_ID,
      templateVersionId: VERSION_ID,
      slugs: ["riscos"],
      forced: ["riscos"],
    });
  });

  // Every other enqueue path in this codebase commits the row first, for
  // api/collector/collect.ts's stated reason.
  it("commits the report_jobs row BEFORE the outbox object", async () => {
    service.loadReportBundle.mockResolvedValue(bundle());
    const order: string[] = [];
    const { db, values } = makeDb();
    values.mockImplementation(() => {
      order.push("insert");
      return { returning: vi.fn().mockResolvedValue([{ id: JOB_ROW_ID }]) };
    });
    enqueue.mockImplementation(async () => {
      order.push("enqueue");
      return Promise.resolve();
    });

    await startAnalysis({ db, enqueue }, CTX, { reportId: REPORT_ID });
    expect(order).toEqual(["insert", "enqueue"]);
  });

  // §7/§12.7 — BYOK travels as a parameter NAME on the payload, and its
  // presence is also how the collector learns raw = owed = 0.
  it("carries ssmParamName when the account brings its own key", async () => {
    credentials.keyBinding.mockReturnValue({
      ssmParamName: `/reportflow/tenants/${TENANT}/gemini-api-key`,
    });
    service.loadReportBundle.mockResolvedValue(bundle());
    const { db } = makeDb();
    await startAnalysis({ db, enqueue }, CTX, { reportId: REPORT_ID });
    expect(payload()["ssmParamName"]).toBe(`/reportflow/tenants/${TENANT}/gemini-api-key`);
  });
});
