// api/trpc/routers/reports.router.test.ts
//
// Wiring only — which input reaches which service call, under WHICH TENANT.
// The freeze protocol is proven in report-publish.test.ts and the draft rules
// in report-service.test.ts.
//
// The one thing this file DOES own is the dependency injection: `publish` and
// `render` must be handed the real S3 helpers, because a service that imported
// them directly could not be tested without an AWS client — and a service that
// received the wrong ones would archive to the wrong prefix.

import { describe, it, expect, beforeEach, vi } from "vitest";

const dbClient = vi.hoisted(() => ({
  db: { transaction: vi.fn() },
  query: vi.fn(),
}));
vi.mock("../../db/client", () => dbClient);

const service = vi.hoisted(() => ({
  attachDocument: vi.fn(),
  createReport: vi.fn(),
  detachDocument: vi.fn(),
  getReport: vi.fn(),
  listClients: vi.fn(),
  listReports: vi.fn(),
  roleOptions: vi.fn(),
  updateSlot: vi.fn(),
  upgradeReportVersion: vi.fn(),
}));
vi.mock("../../services/report-service", () => service);

const publish = vi.hoisted(() => ({ publishReport: vi.fn(), renderReport: vi.fn() }));
vi.mock("../../services/report-publish", () => publish);

const storage = vi.hoisted(() => ({
  frozenReportKey: vi.fn(),
  getFrozenReport: vi.fn(),
  deleteFrozenReport: vi.fn(),
  putFrozenReport: vi.fn(),
}));
vi.mock("../../lib/storage", () => ({
  ...storage,
  createPresignedUploadUrl: vi.fn(),
  headDocument: vi.fn(),
  getDocumentBytes: vi.fn(),
  MAX_UPLOAD_BYTES: 26_214_400,
  REQUIRED_CONTENT_TYPE: "application/pdf",
}));

const { appRouter } = await import("../router");

const TENANT = "org_2abcTENANT";
const OTHER_TENANT = "org_2zzzOTHER";
const USER = "user-1";
const REPORT_ID = "44444444-4444-4444-8444-444444444444";
const VERSION_ID = "55555555-5555-4555-8555-555555555555";
const EXTRACTION_ID = "66666666-6666-4666-8666-666666666666";

function callerFor(tenantId: string) {
  return appRouter.createCaller({ tenantId, userId: USER, role: "member" });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reports.create", () => {
  it("passes the caller's own tenant and user to the service", async () => {
    service.createReport.mockResolvedValue({ id: REPORT_ID });
    await callerFor(TENANT).reports.create({
      templateVersionId: VERSION_ID,
      clientId: null,
      title: "T",
    });
    expect(service.createReport).toHaveBeenCalledWith(
      dbClient.db,
      { tenantId: TENANT, userId: USER },
      expect.objectContaining({ templateVersionId: VERSION_ID }),
    );
  });

  it("scopes to whichever tenant is calling — the cross-tenant case", async () => {
    service.createReport.mockResolvedValue({ id: REPORT_ID });
    await callerFor(OTHER_TENANT).reports.create({
      templateVersionId: VERSION_ID,
      clientId: null,
      title: null,
    });
    expect(service.createReport).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: OTHER_TENANT, userId: USER },
      expect.anything(),
    );
  });

  it("refuses a version id that is not a uuid before any service runs", async () => {
    await expect(
      callerFor(TENANT).reports.create({
        templateVersionId: "not-a-uuid",
        clientId: null,
        title: null,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(service.createReport).not.toHaveBeenCalled();
  });
});

describe("reports.attach / updateSlot", () => {
  it("attaches under the caller's tenant", async () => {
    service.attachDocument.mockResolvedValue({ attached: 1 });
    await callerFor(TENANT).reports.attach({
      reportId: REPORT_ID,
      roleKey: "faturas",
      extractionId: EXTRACTION_ID,
    });
    expect(service.attachDocument).toHaveBeenCalledWith(
      dbClient.db,
      { tenantId: TENANT, userId: USER },
      { reportId: REPORT_ID, roleKey: "faturas", extractionId: EXTRACTION_ID },
    );
  });

  it("refuses a role key that is not a legal path segment", async () => {
    await expect(
      callerFor(TENANT).reports.attach({
        reportId: REPORT_ID,
        roleKey: "faturas.x",
        extractionId: EXTRACTION_ID,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(service.attachDocument).not.toHaveBeenCalled();
  });

  it("never lets the client send `edited` — the mutation MEANS edited (§5.2)", async () => {
    service.updateSlot.mockResolvedValue({ ok: true });
    await callerFor(TENANT).reports.updateSlot({
      reportId: REPORT_ID,
      slug: "notas",
      text: "prosa",
    });
    const passed = service.updateSlot.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(passed).not.toHaveProperty("edited");
  });
});

describe("reports.render / publish", () => {
  it("hands the publish path the real S3 helpers, keyed on the frozen prefix", async () => {
    publish.publishReport.mockResolvedValue({ frozenAt: "t", frozenKey: "k", published: true });
    await callerFor(TENANT).reports.publish({ reportId: REPORT_ID });
    expect(publish.publishReport).toHaveBeenCalledWith(
      expect.objectContaining({
        db: dbClient.db,
        frozenKey: storage.frozenReportKey,
        putFrozen: storage.putFrozenReport,
        getFrozen: storage.getFrozenReport,
        deleteFrozen: storage.deleteFrozenReport,
      }),
      { tenantId: TENANT, userId: USER },
      REPORT_ID,
    );
  });

  it("renders under the caller's tenant", async () => {
    publish.renderReport.mockResolvedValue({ status: "aguardando", missingRoles: [] });
    await callerFor(TENANT).reports.render({ reportId: REPORT_ID });
    expect(publish.renderReport).toHaveBeenCalledWith(expect.anything(), TENANT, REPORT_ID);
  });

  it("rejects an anonymous caller", async () => {
    const anon = appRouter.createCaller({ tenantId: null, userId: null, role: null });
    await expect(anon.reports.publish({ reportId: REPORT_ID })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
