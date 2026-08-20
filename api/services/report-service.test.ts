// api/services/report-service.test.ts
//
// Three guarantees, and they are the reason this file exists rather than a
// happy-path smoke test:
//
//   1. `assertVersionVisible` runs on createReport, BEFORE anything else. The
//      version row carries no tenant_id, so that call is the only thing
//      between "pin any version by id" and reading another org's template.
//   2. A document is bound BY ROLE and the role decides what fits (§3.2).
//   3. A human edit sets `edited: true` (§5.2) — the flag regeneration reads.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbLike } from "../collector/job-state";

const access = vi.hoisted(() => ({
  assertVersionVisible: vi.fn(),
  getOutboundTemplateVersion: vi.fn(),
}));
vi.mock("../db/outbound-access", () => access);

const { attachDocument, createReport, loadReportBundle, updateSlot, upgradeReportVersion } =
  await import("./report-service");

const TENANT = "org_2abcTENANT";
const OTHER_TENANT = "org_2zzzOTHER";
const USER = "user-1";
const CTX = { tenantId: TENANT, userId: USER };
const REPORT_ID = "44444444-4444-4444-8444-444444444444";
const VERSION_ID = "55555555-5555-4555-8555-555555555555";
const EXTRACTION_ID = "66666666-6666-4666-8666-666666666666";
const FATURA_TYPE = "11111111-1111-4111-8111-111111111111";
const CONTRATO_TYPE = "22222222-2222-4222-8222-222222222222";

const ROLES = [
  {
    key: "faturas",
    documentTypeId: FATURA_TYPE,
    provider: "House Living",
    documentType: "Fatura",
    cardinality: "many",
    required: true,
  },
  {
    key: "contrato",
    documentTypeId: CONTRATO_TYPE,
    provider: "House Living",
    documentType: "Contrato",
    cardinality: "one",
    required: false,
  },
];

const SLOTS = [{ slug: "notas", guideline: "g", maxWords: 120 }];

function reportRow(over: Record<string, unknown> = {}) {
  return {
    id: REPORT_ID,
    tenantId: TENANT,
    clientId: null,
    templateVersionId: VERSION_ID,
    title: "Relatório",
    contentJson: { slots: {} },
    frozenAt: null,
    frozenHtmlS3Key: null,
    ...over,
  };
}

/** Fake handle: `select()` consumes `selectQueue` in order; insert/update/
 * delete record their calls so the test can assert WHAT was written. */
function makeDb(selectQueue: unknown[][]) {
  const queue = [...selectQueue];
  const inserted: unknown[] = [];
  const updated: unknown[] = [];
  const deleted: number[] = [];

  const chain = (rows: unknown[]): Record<string, unknown> => {
    const node: Record<string, unknown> = {};
    for (const verb of [
      "from",
      "innerJoin",
      "leftJoin",
      "where",
      "orderBy",
      "onConflictDoNothing",
      "set",
      "returning",
    ]) {
      node[verb] = vi.fn().mockReturnValue(node);
    }
    node["limit"] = vi.fn().mockResolvedValue(rows);
    node["then"] = (resolve: (v: unknown) => unknown) => resolve(rows);
    return node;
  };

  return {
    calls: { inserted, updated, deleted },
    select: vi.fn().mockImplementation(() => chain(queue.shift() ?? [])),
    insert: vi.fn().mockImplementation(() => {
      const node = chain([{ id: REPORT_ID }]);
      node["values"] = vi.fn().mockImplementation((v: unknown) => {
        inserted.push(v);
        return node;
      });
      return node;
    }),
    update: vi.fn().mockImplementation(() => {
      const node = chain([{ id: REPORT_ID }]);
      node["set"] = vi.fn().mockImplementation((v: unknown) => {
        updated.push(v);
        return node;
      });
      return node;
    }),
    delete: vi.fn().mockImplementation(() => {
      deleted.push(1);
      return chain([]);
    }),
  };
}

/** The reads `loadReportBundle` performs, in order: the report, the attached
 * documents, and (only when clientId is set) the client. */
function bundleQueue(report: Record<string, unknown>, attached: unknown[] = []): unknown[][] {
  return [[report], attached];
}

beforeEach(() => {
  vi.clearAllMocks();
  access.getOutboundTemplateVersion.mockResolvedValue({
    id: VERSION_ID,
    version: 3,
    html: "<p>x</p>",
    inputsJson: ROLES,
    slotsJson: SLOTS,
  });
  access.assertVersionVisible.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------

describe("createReport", () => {
  it("asserts the version is visible to the caller BEFORE inserting", async () => {
    const db = makeDb([]);
    await createReport(db as unknown as DbLike, CTX, {
      templateVersionId: VERSION_ID,
      clientId: null,
      title: "T",
    });
    expect(access.assertVersionVisible).toHaveBeenCalledWith(db, VERSION_ID, TENANT);
  });

  it("passes the CALLER's tenant, so a version is checked against who is asking", async () => {
    const db = makeDb([]);
    await createReport(
      db as unknown as DbLike,
      { tenantId: OTHER_TENANT, userId: USER },
      {
        templateVersionId: VERSION_ID,
        clientId: null,
        title: null,
      },
    );
    expect(access.assertVersionVisible).toHaveBeenCalledWith(db, VERSION_ID, OTHER_TENANT);
  });

  it("does not insert anything when the version belongs to another tenant", async () => {
    access.assertVersionVisible.mockRejectedValue(new Error("outside tenant"));
    const db = makeDb([]);
    await expect(
      createReport(db as unknown as DbLike, CTX, {
        templateVersionId: VERSION_ID,
        clientId: null,
        title: null,
      }),
    ).rejects.toThrowError(/outside tenant/u);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("refuses a client id the caller does not own", async () => {
    const db = makeDb([[]]); // client lookup finds nothing under this tenant
    await expect(
      createReport(db as unknown as DbLike, CTX, {
        templateVersionId: VERSION_ID,
        clientId: "77777777-7777-4777-8777-777777777777",
        title: null,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

// ---------------------------------------------------------------------------

describe("attachDocument", () => {
  it("refuses a role the pinned version does not declare", async () => {
    const db = makeDb(bundleQueue(reportRow()));
    await expect(
      attachDocument(db as unknown as DbLike, CTX, {
        reportId: REPORT_ID,
        roleKey: "inventado",
        extractionId: EXTRACTION_ID,
      }),
    ).rejects.toThrowError(/não existe nesta versão/u);
  });

  it("refuses an extraction whose document is of the wrong type", async () => {
    // `docs[0]` cannot tell an invoice from a contract — this check is what
    // makes the role mean something.
    const db = makeDb([
      ...bundleQueue(reportRow()),
      [{ id: EXTRACTION_ID, documentTypeId: CONTRATO_TYPE, typeName: "Contrato" }],
    ]);
    await expect(
      attachDocument(db as unknown as DbLike, CTX, {
        reportId: REPORT_ID,
        roleKey: "faturas",
        extractionId: EXTRACTION_ID,
      }),
    ).rejects.toThrowError(/exige House Living \/ Fatura/u);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("binds a matching extraction under the role key", async () => {
    const db = makeDb([
      ...bundleQueue(reportRow()),
      [{ id: EXTRACTION_ID, documentTypeId: FATURA_TYPE, typeName: "Fatura" }],
    ]);
    await attachDocument(db as unknown as DbLike, CTX, {
      reportId: REPORT_ID,
      roleKey: "faturas",
      extractionId: EXTRACTION_ID,
    });
    expect(db.calls.inserted[0]).toMatchObject({
      tenantId: TENANT,
      reportId: REPORT_ID,
      roleKey: "faturas",
      extractionId: EXTRACTION_ID,
    });
  });

  it("REPLACES the binding of a `one` role rather than accumulating", async () => {
    const db = makeDb([
      ...bundleQueue(reportRow(), [
        {
          roleKey: "contrato",
          sortOrder: 0,
          extractionId: "old",
          documentId: "d",
          fileName: "old.pdf",
          data: {},
        },
      ]),
      [{ id: EXTRACTION_ID, documentTypeId: CONTRATO_TYPE, typeName: "Contrato" }],
    ]);
    await attachDocument(db as unknown as DbLike, CTX, {
      reportId: REPORT_ID,
      roleKey: "contrato",
      extractionId: EXTRACTION_ID,
    });
    expect(db.calls.deleted).toHaveLength(1);
    expect(db.calls.inserted[0]).toMatchObject({ roleKey: "contrato", sortOrder: 0 });
  });

  it("refuses to touch a published report", async () => {
    const db = makeDb(
      bundleQueue(
        reportRow({ frozenAt: "2026-08-20T00:00:00Z", frozenHtmlS3Key: "frozen/x.html" }),
      ),
    );
    await expect(
      attachDocument(db as unknown as DbLike, CTX, {
        reportId: REPORT_ID,
        roleKey: "faturas",
        extractionId: EXTRACTION_ID,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

// ---------------------------------------------------------------------------

describe("updateSlot", () => {
  it("sets edited:true — the flag regeneration reads (§5.2)", async () => {
    const db = makeDb(bundleQueue(reportRow()));
    await updateSlot(db as unknown as DbLike, CTX, {
      reportId: REPORT_ID,
      slug: "notas",
      text: "Prosa escrita por uma pessoa.",
    });
    expect(db.calls.updated[0]).toMatchObject({
      contentJson: { slots: { notas: { text: "Prosa escrita por uma pessoa.", edited: true } } },
    });
  });

  it("preserves the other slots' content and flags", async () => {
    const db = makeDb(
      bundleQueue(
        reportRow({
          contentJson: { slots: { outro: { text: "gerado", edited: false } } },
        }),
      ),
    );
    await updateSlot(db as unknown as DbLike, CTX, {
      reportId: REPORT_ID,
      slug: "notas",
      text: "novo",
    });
    expect(db.calls.updated[0]).toMatchObject({
      contentJson: {
        slots: {
          outro: { text: "gerado", edited: false },
          notas: { text: "novo", edited: true },
        },
      },
    });
  });

  it("refuses a slug the pinned version does not declare", async () => {
    const db = makeDb(bundleQueue(reportRow()));
    await expect(
      updateSlot(db as unknown as DbLike, CTX, {
        reportId: REPORT_ID,
        slug: "inexistente",
        text: "x",
      }),
    ).rejects.toThrowError(/não existe nesta versão/u);
  });
});

describe("upgradeReportVersion", () => {
  it("is explicit and still goes through assertVersionVisible (§5.3)", async () => {
    const db = makeDb([[reportRow()]]);
    await upgradeReportVersion(db as unknown as DbLike, CTX, {
      reportId: REPORT_ID,
      templateVersionId: "88888888-8888-4888-8888-888888888888",
    });
    expect(access.assertVersionVisible).toHaveBeenCalledWith(
      db,
      "88888888-8888-4888-8888-888888888888",
      TENANT,
    );
    // content_json is carried across untouched — deleting slots the new
    // version no longer declares would be the §5.2 bug through the front door.
    expect(db.calls.updated[0]).not.toHaveProperty("contentJson");
  });
});

describe("loadReportBundle", () => {
  it("reads the version through the visibility join, not by raw id", async () => {
    const db = makeDb(bundleQueue(reportRow()));
    const bundle = await loadReportBundle(db as unknown as DbLike, TENANT, REPORT_ID);
    expect(access.getOutboundTemplateVersion).toHaveBeenCalledWith(db, TENANT, VERSION_ID);
    expect(bundle.roles).toHaveLength(2);
    expect(bundle.slots).toEqual(SLOTS);
  });

  it("reports a report belonging to another tenant as not found", async () => {
    const db = makeDb([[]]);
    await expect(
      loadReportBundle(db as unknown as DbLike, OTHER_TENANT, REPORT_ID),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
