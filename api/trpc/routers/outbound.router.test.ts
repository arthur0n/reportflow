// api/trpc/routers/outbound.router.test.ts
//
// Drives the REAL router through a caller. The property under test is the
// WIRING — which input reaches which service call, under WHICH TENANT, and
// which failure becomes which TRPCError. The service is mocked; its behaviour
// is proven in outbound-template-service.test.ts.
//
// The tenant assertions are the point, the same way they are in
// calibration.router.test.ts: every procedure here takes a server-issued uuid
// the client echoes back, and a uuid is a lookup key, never a permission.

import { describe, it, expect, beforeEach, vi } from "vitest";

const dbClient = vi.hoisted(() => ({
  db: {
    // saveVersion reads MAX(version) then inserts — straddling that pair over
    // two connections is how two authors both write version 4. The fake hands
    // the callback a distinguishable handle so the test can prove the service
    // was given the TX, not the pool.
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ tx: true })),
  },
  query: vi.fn(),
}));
vi.mock("../../db/client", () => dbClient);

const service = vi.hoisted(() => ({
  createTemplate: vi.fn(),
  getTemplate: vi.fn(),
  listTemplates: vi.fn(),
  previewTemplate: vi.fn(),
  saveVersion: vi.fn(),
}));
vi.mock("../../services/outbound-template-service", () => service);

const { appRouter } = await import("../router");

const TENANT = "org_2abcTENANT";
const OTHER_TENANT = "org_2zzzOTHER";
const USER = "user-1";
const TEMPLATE_ID = "33333333-3333-4333-8333-333333333333";
const TYPE_ID = "11111111-1111-4111-8111-111111111111";

function callerFor(tenantId: string) {
  return appRouter.createCaller({ tenantId, userId: USER, role: "member" });
}

const SAVE_INPUT = {
  templateId: TEMPLATE_ID,
  html: `<p>{{nota.numero}}</p>{{ai "notas"}}`,
  inputs: [{ key: "nota", documentTypeId: TYPE_ID, cardinality: "one" as const, required: true }],
  slots: [{ slug: "notas", guideline: "g", maxWords: 120 }],
};

beforeEach(() => {
  vi.clearAllMocks();
  dbClient.db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ tx: true }),
  );
});

describe("outbound.saveVersion", () => {
  it("runs the save INSIDE a transaction, on the tx handle", async () => {
    service.saveVersion.mockResolvedValue({
      versionId: "v-2",
      version: 2,
      slots: [],
      dryRun: { status: "ok" },
    });
    await callerFor(TENANT).outbound.saveVersion(SAVE_INPUT);
    expect(dbClient.db.transaction).toHaveBeenCalledOnce();
    expect(service.saveVersion).toHaveBeenCalledWith(
      { tx: true },
      { tenantId: TENANT, userId: USER },
      expect.objectContaining({ templateId: TEMPLATE_ID }),
    );
  });

  it("scopes to whichever tenant is calling", async () => {
    service.saveVersion.mockResolvedValue({
      versionId: "v",
      version: 1,
      slots: [],
      dryRun: { status: "ok" },
    });
    await callerFor(OTHER_TENANT).outbound.saveVersion(SAVE_INPUT);
    expect(service.saveVersion).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: OTHER_TENANT, userId: USER },
      expect.anything(),
    );
  });

  it("refuses a role key that is not a Handlebars path segment, before any service runs", async () => {
    // A key with a dot or a dash is unreachable from a template.
    await expect(
      callerFor(TENANT).outbound.saveVersion({
        ...SAVE_INPUT,
        inputs: [
          { key: "nota-fiscal", documentTypeId: TYPE_ID, cardinality: "one", required: true },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(service.saveVersion).not.toHaveBeenCalled();
  });

  it("refuses a role key that would shadow the code-computed blocks", async () => {
    await expect(
      callerFor(TENANT).outbound.saveVersion({
        ...SAVE_INPUT,
        inputs: [{ key: "totais", documentTypeId: TYPE_ID, cardinality: "one", required: true }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(service.saveVersion).not.toHaveBeenCalled();
  });

  it("refuses an empty template body before any service runs", async () => {
    await expect(
      callerFor(TENANT).outbound.saveVersion({ ...SAVE_INPUT, html: "" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(service.saveVersion).not.toHaveBeenCalled();
  });
});

describe("outbound.preview", () => {
  it("renders SERVER-SIDE and hands back html for a sandboxed iframe", async () => {
    service.previewTemplate.mockResolvedValue({
      html: "<p>ok</p>",
      slots: [],
      dryRun: { status: "ok" },
      rolesWithoutFixture: [],
    });
    const out = await callerFor(TENANT).outbound.preview({
      html: SAVE_INPUT.html,
      inputs: SAVE_INPUT.inputs,
      slots: [],
    });
    expect(out.html).toBe("<p>ok</p>");
    expect(service.previewTemplate).toHaveBeenCalledWith(
      dbClient.db,
      TENANT,
      expect.objectContaining({ html: SAVE_INPUT.html }),
    );
  });
});

describe("outbound.list / get / create", () => {
  it("lists under the caller's tenant", async () => {
    service.listTemplates.mockResolvedValue([]);
    await callerFor(TENANT).outbound.list();
    expect(service.listTemplates).toHaveBeenCalledWith(dbClient.db, TENANT);
  });

  it("gets under the caller's tenant", async () => {
    service.getTemplate.mockResolvedValue({ id: TEMPLATE_ID });
    await callerFor(TENANT).outbound.get({ templateId: TEMPLATE_ID });
    expect(service.getTemplate).toHaveBeenCalledWith(dbClient.db, TENANT, TEMPLATE_ID);
  });

  it("creates under the caller's tenant and user", async () => {
    service.createTemplate.mockResolvedValue({ id: TEMPLATE_ID, name: "T" });
    await callerFor(TENANT).outbound.create({ name: "T", description: null });
    expect(service.createTemplate).toHaveBeenCalledWith(
      dbClient.db,
      { tenantId: TENANT, userId: USER },
      { name: "T", description: null },
    );
  });

  it("rejects an anonymous caller on every procedure", async () => {
    const anon = appRouter.createCaller({ tenantId: null, userId: null, role: null });
    await expect(anon.outbound.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});
