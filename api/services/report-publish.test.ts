// api/services/report-publish.test.ts
//
// THE FREEZE PROTOCOL, asserted as a protocol and not as a happy path.
//
//   * the numeral guard BLOCKS publication (§12.12c) and names slot + token
//   * a REFUTED claim blocks it too (§12.13), and rewriting the slot is the
//     way out — the verifier never rewrites, so without that door one
//     refutation would wedge a report shut forever
//   * a placeholder never reaches a client document
//   * S3 is written BEFORE the row is stamped
//   * the stamp is a compare-and-set, so a second publish reports the first
//   * a published report is printed from what was ARCHIVED, never re-rendered
//
// `loadReportBundle` is mocked: it is proven in report-service.test.ts, and
// stubbing it is what lets each case state its own report in three lines
// instead of eleven queued fake rows.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbLike } from "../collector/job-state";
import type * as ReportServiceModule from "./report-service";

const service = vi.hoisted(() => ({
  loadReportBundle: vi.fn(),
}));
// Only the LOADER is stubbed. `reportContextOf` — the §12.12b deterministic
// half — is deliberately the real one: it is what decides the numerals the
// guard is allowed to accept, and a stub would be the thing deciding whether
// the guard blocks.
vi.mock("./report-service", async (importOriginal) => {
  const actual = await importOriginal<typeof ReportServiceModule>();
  return { ...actual, loadReportBundle: service.loadReportBundle };
});

const { publishReport, renderReport } = await import("./report-publish");

const TENANT = "org_2abcTENANT";
const USER = "user-1";
const CTX = { tenantId: TENANT, userId: USER };
const REPORT_ID = "44444444-4444-4444-8444-444444444444";

const FATURAS_ROLE = {
  key: "faturas",
  documentTypeId: "11111111-1111-4111-8111-111111111111",
  provider: "House Living",
  documentType: "Fatura",
  cardinality: "many" as const,
  required: true,
};

const FATURA = {
  id: "e1",
  data: {
    numero: "FT 1",
    totais: { iliquido: "100,00 €", iva: "23,00 €", documento: "123,00 €" },
  },
};

const HTML = `<p>{{money totais.faturas.documento_cents}}</p><div>{{ai "notas"}}</div>`;

function bundle(over: {
  slots?: Record<string, { text: string; edited: boolean }>;
  frozenAt?: string | null;
  frozenHtmlS3Key?: string | null;
  attached?: Map<
    string,
    {
      extractionId: string;
      documentId: string;
      fileName: string | null;
      sortOrder: number;
      data: unknown;
    }[]
  >;
  html?: string;
}) {
  const attached =
    over.attached ??
    new Map([
      [
        "faturas",
        [
          {
            extractionId: FATURA.id,
            documentId: "d1",
            fileName: "ft1.pdf",
            sortOrder: 0,
            data: FATURA.data,
          },
        ],
      ],
    ]);
  return {
    report: {
      id: REPORT_ID,
      tenantId: TENANT,
      title: "Relatório",
      frozenAt: over.frozenAt ?? null,
      frozenHtmlS3Key: over.frozenHtmlS3Key ?? null,
    },
    version: { id: "v1", version: 3, html: over.html ?? HTML },
    roles: [FATURAS_ROLE],
    slots: [{ slug: "notas", guideline: "g", maxWords: 120 }],
    content: { slots: over.slots ?? {} },
    attached,
    clientName: "Cliente",
  };
}

/** The db half only matters for the compare-and-set. `updateReturns` is what
 * `UPDATE … WHERE frozen_at IS NULL … RETURNING id` yields: one row when this
 * caller won, zero when it lost. */
function makeDb(updateReturns: unknown[]) {
  const node: Record<string, unknown> = {};
  for (const verb of ["set", "where"]) {
    node[verb] = vi.fn().mockReturnValue(node);
  }
  node["returning"] = vi.fn().mockResolvedValue(updateReturns);
  return { update: vi.fn().mockReturnValue(node) };
}

/** `frozenKey` mints a FRESH key per call, exactly as api/lib/storage.ts does
 * — a shared key is the defect this file now covers. */
function makeDeps(db: unknown, opts: { frozenHtml?: string | null } = {}) {
  let attempt = 0;
  return {
    db: db as DbLike,
    frozenKey: vi.fn((tenantId: string, reportId: string) => {
      attempt += 1;
      return `frozen/${tenantId}/${reportId}/attempt-${String(attempt)}.html`;
    }),
    putFrozen: vi.fn().mockResolvedValue(undefined),
    getFrozen: vi.fn().mockResolvedValue(opts.frozenHtml ?? null),
    deleteFrozen: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe("renderReport", () => {
  it("reports the waiting state instead of erroring when a required role is empty", async () => {
    service.loadReportBundle.mockResolvedValue(bundle({ attached: new Map() }));
    const out = await renderReport(makeDeps(makeDb([])), TENANT, REPORT_ID);
    expect(out).toEqual({ status: "aguardando", missingRoles: ["faturas"] });
  });

  it("renders a draft with a visible placeholder for prose that does not exist yet", async () => {
    service.loadReportBundle.mockResolvedValue(bundle({}));
    const out = await renderReport(makeDeps(makeDb([])), TENANT, REPORT_ID);
    expect(out.status).toBe("rascunho");
    if (out.status !== "rascunho") return;
    expect(out.html).toContain("123,00 €");
    expect(out.missingSlots).toEqual(["notas"]);
    expect(out.html).toContain("notas");
  });

  it("surfaces numeral violations on a draft WITHOUT refusing to render", async () => {
    // A draft that refused would hide the very prose a human has to fix.
    service.loadReportBundle.mockResolvedValue(
      bundle({ slots: { notas: { text: "O total foi 9.999,99 €.", edited: false } } }),
    );
    const out = await renderReport(makeDeps(makeDb([])), TENANT, REPORT_ID);
    expect(out.status).toBe("rascunho");
    if (out.status !== "rascunho") return;
    expect(out.numeralViolations).toEqual([{ slot: "notas", token: "9.999,99" }]);
  });

  it("prints a PUBLISHED report from the archive, never from a re-render", async () => {
    service.loadReportBundle.mockResolvedValue(
      bundle({ frozenAt: "2026-08-20T10:00:00Z", frozenHtmlS3Key: "frozen/t/r.html" }),
    );
    const deps = makeDeps(makeDb([]), { frozenHtml: "<p>arquivado</p>" });
    const out = await renderReport(deps, TENANT, REPORT_ID);
    expect(out).toMatchObject({ status: "publicado", html: "<p>arquivado</p>" });
    expect(deps.getFrozen).toHaveBeenCalledWith("frozen/t/r.html");
  });

  it("still reports a published report when its archived object is gone", async () => {
    service.loadReportBundle.mockResolvedValue(
      bundle({ frozenAt: "2026-08-20T10:00:00Z", frozenHtmlS3Key: "frozen/t/r.html" }),
    );
    const out = await renderReport(makeDeps(makeDb([]), { frozenHtml: null }), TENANT, REPORT_ID);
    expect(out).toMatchObject({ status: "publicado", html: null });
  });
});

// ---------------------------------------------------------------------------

describe("publishReport", () => {
  const GOOD_SLOTS = { notas: { text: "Foram 123,00 € no período.", edited: false } };

  it("freezes: S3 first, then the stamp", async () => {
    service.loadReportBundle.mockResolvedValue(bundle({ slots: GOOD_SLOTS }));
    const db = makeDb([{ id: REPORT_ID }]);
    const deps = makeDeps(db);

    const out = await publishReport(deps, CTX, REPORT_ID);

    expect(deps.putFrozen).toHaveBeenCalledWith(
      `frozen/${TENANT}/${REPORT_ID}/attempt-1.html`,
      expect.stringContaining("123,00 €"),
    );
    // Order is the protocol: a stamp with no artifact is a broken document at
    // the exact moment a client is being sent one.
    const putOrder = deps.putFrozen.mock.invocationCallOrder[0] ?? 0;
    const updOrder = db.update.mock.invocationCallOrder[0] ?? 0;
    expect(putOrder).toBeLessThan(updOrder);
    expect(out.published).toBe(true);
    // The row names the exact object THIS attempt wrote.
    expect(out.frozenKey).toBe(`frozen/${TENANT}/${REPORT_ID}/attempt-1.html`);
    expect(deps.deleteFrozen).not.toHaveBeenCalled();
  });

  it("renders the human's prose into the archive, escaped", async () => {
    service.loadReportBundle.mockResolvedValue(
      bundle({ slots: { notas: { text: "<b>123,00 €</b>", edited: true } } }),
    );
    const deps = makeDeps(makeDb([{ id: REPORT_ID }]));
    await publishReport(deps, CTX, REPORT_ID);
    const html = deps.putFrozen.mock.calls[0]?.[1] as string;
    expect(html).toContain("&lt;b&gt;");
    expect(html).not.toContain("<b>123,00");
  });

  it("BLOCKS on a numeral with no deterministic source, naming slot and token", async () => {
    service.loadReportBundle.mockResolvedValue(
      bundle({ slots: { notas: { text: "O total foi de 4.590,70 €." } as never } }),
    );
    const deps = makeDeps(makeDb([{ id: REPORT_ID }]));
    let caught: unknown;
    try {
      await publishReport(deps, CTX, REPORT_ID);
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: "BAD_REQUEST" });
    expect((caught as { message: string }).message).toMatch(/slot "notas": "4\.590,70"/u);
    expect(deps.putFrozen).not.toHaveBeenCalled();
  });

  it("accepts a figure that is only in the CODE-COMPUTED aggregate", async () => {
    // §12.12b: the model receives computed figures and writes prose around
    // them. 123 cents never appears verbatim in the extraction JSON.
    service.loadReportBundle.mockResolvedValue(
      bundle({ slots: { notas: { text: "Total consolidado: 12300 cêntimos.", edited: false } } }),
    );
    const deps = makeDeps(makeDb([{ id: REPORT_ID }]));
    await expect(publishReport(deps, CTX, REPORT_ID)).resolves.toMatchObject({ published: true });
  });

  it("refuses to publish while a required role is unfilled", async () => {
    service.loadReportBundle.mockResolvedValue(bundle({ attached: new Map(), slots: GOOD_SLOTS }));
    await expect(publishReport(makeDeps(makeDb([])), CTX, REPORT_ID)).rejects.toThrowError(
      /Aguardando documento para: faturas/u,
    );
  });

  it("refuses to publish a placeholder — an ungenerated slot is not a report", async () => {
    service.loadReportBundle.mockResolvedValue(bundle({ slots: {} }));
    const deps = makeDeps(makeDb([]));
    await expect(publishReport(deps, CTX, REPORT_ID)).rejects.toThrowError(/Ainda sem texto/u);
    expect(deps.putFrozen).not.toHaveBeenCalled();
  });

  it("treats whitespace-only prose as unwritten", async () => {
    service.loadReportBundle.mockResolvedValue(
      bundle({ slots: { notas: { text: "   \n ", edited: true } } }),
    );
    await expect(publishReport(makeDeps(makeDb([])), CTX, REPORT_ID)).rejects.toThrowError(
      /Ainda sem texto/u,
    );
  });
});

// ---------------------------------------------------------------------------
// Concurrency. Two tabs, one double-click, one retried request.
// ---------------------------------------------------------------------------

describe("publishReport — concurrent publishers", () => {
  const GOOD_SLOTS = { notas: { text: "Foram 123,00 € no período.", edited: false } };

  it("is idempotent: publishing an already-published report re-reports it", async () => {
    service.loadReportBundle.mockResolvedValue(
      bundle({
        slots: GOOD_SLOTS,
        frozenAt: "2026-08-20T10:00:00Z",
        frozenHtmlS3Key: "frozen/t/r.html",
      }),
    );
    const deps = makeDeps(makeDb([]));
    const out = await publishReport(deps, CTX, REPORT_ID);
    expect(out).toEqual({
      frozenAt: "2026-08-20T10:00:00Z",
      frozenKey: "frozen/t/r.html",
      published: false,
    });
    expect(deps.putFrozen).not.toHaveBeenCalled();
  });

  it("loses the compare-and-set gracefully and reports the winner's stamp", async () => {
    // Two tabs, one double-click. `WHERE frozen_at IS NULL` returns no row for
    // the loser, which re-reads rather than minting a second frozen_at.
    service.loadReportBundle
      .mockResolvedValueOnce(bundle({ slots: GOOD_SLOTS }))
      .mockResolvedValueOnce(
        bundle({
          slots: GOOD_SLOTS,
          frozenAt: "2026-08-20T10:00:00Z",
          frozenHtmlS3Key: `frozen/${TENANT}/${REPORT_ID}/winner.html`,
        }),
      );
    const out = await publishReport(makeDeps(makeDb([])), CTX, REPORT_ID);
    expect(out).toMatchObject({
      published: false,
      frozenAt: "2026-08-20T10:00:00Z",
      frozenKey: `frozen/${TENANT}/${REPORT_ID}/winner.html`,
    });
  });

  it("A LOSING PUBLISHER CANNOT CORRUPT THE WINNER'S ARCHIVE", async () => {
    // The defect this replaced: one key per REPORT meant both publishers wrote
    // the SAME object, and nothing orders the loser's PUT before the winner's
    // — a slow loser overwrote the archive the winner's row already pointed
    // at, after publication, with bytes from a different draft state.
    const winnerKey = `frozen/${TENANT}/${REPORT_ID}/winner.html`;
    service.loadReportBundle
      .mockResolvedValueOnce(bundle({ slots: GOOD_SLOTS }))
      .mockResolvedValueOnce(
        bundle({
          slots: GOOD_SLOTS,
          frozenAt: "2026-08-20T10:00:00Z",
          frozenHtmlS3Key: winnerKey,
        }),
      );
    const deps = makeDeps(makeDb([])); // zero rows returned => this caller LOST

    const out = await publishReport(deps, CTX, REPORT_ID);

    // It wrote its own object, never the winner's.
    const writtenKey = deps.putFrozen.mock.calls[0]?.[0] as string;
    expect(writtenKey).not.toBe(winnerKey);
    expect(deps.putFrozen).toHaveBeenCalledTimes(1);
    // And it cleaned up exactly that object — not the winner's.
    expect(deps.deleteFrozen).toHaveBeenCalledWith(writtenKey);
    expect(deps.deleteFrozen).not.toHaveBeenCalledWith(winnerKey);
    expect(out.frozenKey).toBe(winnerKey);
  });

  it("still reports the winner when the orphan cleanup itself fails", async () => {
    // An orphan is unreferenced bytes. Failing the publish because a cleanup
    // failed would be a worse outcome for the same fact.
    service.loadReportBundle
      .mockResolvedValueOnce(bundle({ slots: GOOD_SLOTS }))
      .mockResolvedValueOnce(
        bundle({
          slots: GOOD_SLOTS,
          frozenAt: "2026-08-20T10:00:00Z",
          frozenHtmlS3Key: `frozen/${TENANT}/${REPORT_ID}/winner.html`,
        }),
      );
    const deps = makeDeps(makeDb([]));
    deps.deleteFrozen.mockRejectedValue(new Error("S3 down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(publishReport(deps, CTX, REPORT_ID)).resolves.toMatchObject({
      published: false,
    });
    warn.mockRestore();
  });

  it("mints a NEW key on a retry, so a failed attempt's bytes are never reused", async () => {
    service.loadReportBundle.mockResolvedValue(bundle({ slots: GOOD_SLOTS }));
    const deps = makeDeps(makeDb([{ id: REPORT_ID }]));
    const first = await publishReport(deps, CTX, REPORT_ID);
    const second = await publishReport(deps, CTX, REPORT_ID);
    expect(first.frozenKey).not.toBe(second.frozenKey);
  });
});

// ---------------------------------------------------------------------------
// §12.13 — the gate nothing downstream can recompute
// ---------------------------------------------------------------------------

describe("publishReport — a contested slot", () => {
  // §12.13. The OTHER hard gate, and the one nothing downstream can
  // recompute: a refutation is a second model's reading of this prose, not a
  // function of the data, so it is read from `content_json` where the
  // collector wrote it.
  it("BLOCKS on a slot the verifier refuted, quoting its reason", async () => {
    service.loadReportBundle.mockResolvedValue(
      bundle({
        slots: {
          notas: {
            text: "Total consolidado: 12300 cêntimos.",
            edited: false,
            refuted: [{ claim: "12300 cêntimos", fundamento: "a soma não confere" }],
          } as never,
        },
      }),
    );
    const deps = makeDeps(makeDb([{ id: REPORT_ID }]));
    let caught: unknown;
    try {
      await publishReport(deps, CTX, REPORT_ID);
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: "BAD_REQUEST" });
    expect((caught as { message: string }).message).toMatch(/notas.*a soma não confere/u);
    expect(deps.putFrozen).not.toHaveBeenCalled();
  });

  // `ilegivel` is not a finding against the prose — the collector never stores
  // one, and a slot that was verified clean carries only `verifiedAt`.
  it("publishes a slot the verifier checked and confirmed", async () => {
    service.loadReportBundle.mockResolvedValue(
      bundle({
        slots: {
          notas: {
            text: "Total consolidado: 12300 cêntimos.",
            edited: false,
            verifiedAt: "2026-08-20T10:00:00.000Z",
          } as never,
        },
      }),
    );
    const deps = makeDeps(makeDb([{ id: REPORT_ID }]));
    await expect(publishReport(deps, CTX, REPORT_ID)).resolves.toMatchObject({ published: true });
  });
});
