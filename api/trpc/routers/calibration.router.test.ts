// api/trpc/routers/calibration.router.test.ts
//
// Drives the REAL router through a caller, because the property under test is
// the WIRING: which input reaches which service call, under WHICH TENANT, and
// which failure becomes which TRPCError with a pt-BR message a user can act
// on. The services are mocked — their behaviour is proven in
// calibration-service.test.ts and calibration-freeze.test.ts — so this file
// stays honest about what it covers.
//
// The tenant assertions are the point. Every procedure here takes a
// server-issued uuid the client echoes back, and a uuid is a lookup key, never
// a permission: if the router ever passed one to a service without
// `ctx.tenantId` alongside it, the service's own ownership check would be
// checking a value the caller chose.

import { describe, it, expect, beforeEach, vi } from "vitest";

const dbClient = vi.hoisted(() => ({
  db: {
    // The freeze must run in ONE transaction (§12.8 has no versioning to roll
    // back to). The fake hands the callback a distinguishable handle so the
    // test can prove the service was given the TX, not the pool.
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ tx: true })),
  },
  query: vi.fn(),
}));
vi.mock("../../db/client", () => dbClient);

const service = vi.hoisted(() => ({
  proposeCalibration: vi.fn(),
  interpretProposalJob: vi.fn(),
  listProviders: vi.fn(),
  listTemplates: vi.fn(),
  getTemplate: vi.fn(),
}));
vi.mock("../../services/calibration-service", () => service);

const freezeService = vi.hoisted(() => ({ freezeCalibration: vi.fn() }));
vi.mock("../../services/calibration-freeze", () => freezeService);

const pollJob = vi.hoisted(() => ({ pollJobRow: vi.fn() }));
vi.mock("../../collector/poll-job", () => pollJob);

const relay = vi.hoisted(() => ({ enqueueRelayJob: vi.fn() }));
vi.mock("../../lib/relay", () => relay);

const storage = vi.hoisted(() => ({
  createPresignedUploadUrl: vi.fn(),
  headDocument: vi.fn(),
  getDocumentBytes: vi.fn(),
}));
vi.mock("../../lib/storage", () => ({
  ...storage,
  MAX_UPLOAD_BYTES: 26_214_400,
  REQUIRED_CONTENT_TYPE: "application/pdf",
}));

const { appRouter } = await import("../router");

const TENANT = "org_2abcTENANT";
const OTHER_TENANT = "org_2zzzOTHER";
const USER = "user-1";
const DOC_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const TEMPLATE_ID = "66666666-6666-4666-8666-666666666666";

function callerFor(tenantId: string) {
  return appRouter.createCaller({ tenantId, userId: USER, role: "member" });
}

const FREEZE_INPUT = {
  provider: { name: "Toysmith" },
  documentType: { name: "Nota Fiscal" },
  sampleDocumentId: DOC_ID,
  inputMode: "text" as const,
  detectHint: ["TOYSMITH COMÉRCIO"],
  fields: [{ name: "numero", type: "string" as const, required: true, description: "Número." }],
};

beforeEach(() => {
  vi.clearAllMocks();
  dbClient.db.transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ tx: true }),
  );
});

describe("calibration.propose", () => {
  it("passes the caller's own tenant and user to the service", async () => {
    service.proposeCalibration.mockResolvedValue({ jobId: JOB_ID });

    const out = await callerFor(TENANT).calibration.propose({ documentId: DOC_ID });

    expect(out).toEqual({ jobId: JOB_ID });
    expect(service.proposeCalibration).toHaveBeenCalledWith(
      expect.objectContaining({
        enqueue: relay.enqueueRelayJob,
        fetchPdf: storage.getDocumentBytes,
      }),
      { tenantId: TENANT, userId: USER },
      { documentId: DOC_ID },
    );
  });

  it("scopes to whichever tenant is calling", async () => {
    service.proposeCalibration.mockResolvedValue({ jobId: JOB_ID });
    await callerFor(OTHER_TENANT).calibration.propose({ documentId: DOC_ID });
    expect(service.proposeCalibration).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: OTHER_TENANT, userId: USER },
      expect.anything(),
    );
  });

  it("refuses an input that is not a uuid before any service runs", async () => {
    await expect(
      callerFor(TENANT).calibration.propose({ documentId: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(service.proposeCalibration).not.toHaveBeenCalled();
  });
});

describe("calibration.pollProposal", () => {
  // Runs THE SAME backstop `jobs.poll` runs — a second implementation would be
  // a second idempotency (§4.1).
  it("polls the row through the shared backstop under the caller's tenant", async () => {
    const row = { id: JOB_ID, status: "done" };
    pollJob.pollJobRow.mockResolvedValue(row);
    service.interpretProposalJob.mockReturnValue({ status: "pending" });

    await callerFor(TENANT).calibration.pollProposal({ jobId: JOB_ID });

    expect(pollJob.pollJobRow).toHaveBeenCalledWith(TENANT, JOB_ID);
    expect(service.interpretProposalJob).toHaveBeenCalledWith(row);
  });

  it("reports a job that is not this tenant's as not found", async () => {
    pollJob.pollJobRow.mockResolvedValue(undefined);
    await expect(
      callerFor(TENANT).calibration.pollProposal({ jobId: JOB_ID }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(service.interpretProposalJob).not.toHaveBeenCalled();
  });

  it("returns the interpreted proposal verbatim", async () => {
    pollJob.pollJobRow.mockResolvedValue({ id: JOB_ID });
    service.interpretProposalJob.mockReturnValue({ status: "failed", error: "falhou" });
    await expect(callerFor(TENANT).calibration.pollProposal({ jobId: JOB_ID })).resolves.toEqual({
      status: "failed",
      error: "falhou",
    });
  });
});

describe("calibration.freeze", () => {
  it("runs the freeze inside one transaction, on the tx handle", async () => {
    freezeService.freezeCalibration.mockResolvedValue({ templateId: TEMPLATE_ID });

    await callerFor(TENANT).calibration.freeze(FREEZE_INPUT);

    expect(dbClient.db.transaction).toHaveBeenCalledTimes(1);
    expect(freezeService.freezeCalibration).toHaveBeenCalledWith(
      { tx: true },
      { tenantId: TENANT, userId: USER },
      expect.objectContaining({ sampleDocumentId: DOC_ID }),
    );
  });

  // The frozen list is what every later extraction is validated against, so
  // the browser's copy is re-checked here rather than trusted through the
  // round trip.
  it("refuses an empty field list", async () => {
    await expect(
      callerFor(TENANT).calibration.freeze({ ...FREEZE_INPUT, fields: [] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(freezeService.freezeCalibration).not.toHaveBeenCalled();
  });

  // An empty container builds `z.strictObject({})`, which rejects every real
  // document — a field list that can never validate is not a field list.
  it("refuses an object[] with no subfields", async () => {
    await expect(
      callerFor(TENANT).calibration.freeze({
        ...FREEZE_INPUT,
        fields: [{ name: "itens", type: "object[]", required: true, description: "Linhas." }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  // Duplicate names break the runtime-built Zod schema silently — the second
  // shape entry simply wins.
  it("refuses two top-level fields with the same name", async () => {
    await expect(
      callerFor(TENANT).calibration.freeze({
        ...FREEZE_INPUT,
        fields: [
          { name: "numero", type: "string", required: true, description: "a" },
          { name: "numero", type: "string", required: true, description: "b" },
        ],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a field name that is not a usable JSON/Handlebars key", async () => {
    await expect(
      callerFor(TENANT).calibration.freeze({
        ...FREEZE_INPUT,
        fields: [{ name: "total geral", type: "money", required: true, description: "x" }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("calibration reads", () => {
  it("lists providers and templates under the caller's own tenant", async () => {
    service.listProviders.mockResolvedValue([]);
    service.listTemplates.mockResolvedValue([]);

    await callerFor(TENANT).calibration.providers();
    await callerFor(OTHER_TENANT).calibration.listTemplates();

    expect(service.listProviders).toHaveBeenCalledWith(expect.anything(), TENANT);
    expect(service.listTemplates).toHaveBeenCalledWith(expect.anything(), OTHER_TENANT);
  });

  it("reads one template under the caller's own tenant", async () => {
    service.getTemplate.mockResolvedValue({ id: TEMPLATE_ID });
    await callerFor(TENANT).calibration.getTemplate({ templateId: TEMPLATE_ID });
    expect(service.getTemplate).toHaveBeenCalledWith(expect.anything(), TENANT, TEMPLATE_ID);
  });
});
