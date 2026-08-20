// api/trpc/routers/extractions.router.test.ts
//
// Drives the REAL router through a caller, because the property under test is
// the WIRING: which input reaches which service call, under WHICH TENANT, and
// which service failure becomes which TRPCError. The service itself
// (api/services/extraction-service.ts) is mocked — its decisions are proven in
// extraction-service.test.ts, and mocking it here is what keeps this file
// honest about what it actually covers.
//
// THE TENANT ASSERTIONS ARE THE POINT. Every procedure below takes a
// browser-supplied uuid; none of them may reach the service with anything but
// `ctx.tenantId`, and a caller for one org must never be able to make a call
// that carries another org's id.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const service = vi.hoisted(() => ({
  startExtraction: vi.fn(),
  getExtractionView: vi.fn(),
  correctExtraction: vi.fn(),
  listExtractionStatus: vi.fn(),
}));
vi.mock("../../services/extraction-service", () => service);

const relay = vi.hoisted(() => ({ enqueueRelayJob: vi.fn() }));
vi.mock("../../lib/relay", () => relay);

const storage = vi.hoisted(() => ({ getDocumentBytes: vi.fn() }));
vi.mock("../../lib/storage", () => storage);

const { appRouter } = await import("../router");

const TENANT = "org-1";
const OTHER_TENANT = "org-2";
const DOC_ID = "22222222-2222-4222-8222-222222222222";
const EXTRACTION_ID = "66666666-6666-4666-8666-666666666666";

function callerFor(tenantId: string) {
  return appRouter.createCaller({ tenantId, userId: "user-1", role: "member" });
}

beforeEach(() => {
  service.startExtraction.mockReset();
  service.getExtractionView.mockReset();
  service.correctExtraction.mockReset();
  service.listExtractionStatus.mockReset();
  relay.enqueueRelayJob.mockReset();
  storage.getDocumentBytes.mockReset();
});

describe("extractions.start", () => {
  it("passes the caller's own tenant and user to the service", async () => {
    service.startExtraction.mockResolvedValue({ outcome: "job", jobId: "job-1" });

    const out = await callerFor(TENANT).extractions.start({ documentId: DOC_ID });

    expect(out).toEqual({ outcome: "job", jobId: "job-1" });
    expect(service.startExtraction).toHaveBeenCalledWith(
      expect.objectContaining({
        enqueue: relay.enqueueRelayJob,
        fetchPdf: storage.getDocumentBytes,
      }),
      { tenantId: TENANT, userId: "user-1" },
      DOC_ID,
    );
  });

  it("never lets one tenant's caller reach the service as another", async () => {
    service.startExtraction.mockResolvedValue({ outcome: "cached", extractionId: EXTRACTION_ID });

    await callerFor(OTHER_TENANT).extractions.start({ documentId: DOC_ID });

    expect(service.startExtraction).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: OTHER_TENANT, userId: "user-1" },
      DOC_ID,
    );
  });

  it("surfaces the service's refusal verbatim", async () => {
    service.startExtraction.mockRejectedValue(
      new TRPCError({
        code: "BAD_REQUEST",
        message: "Defina o tipo do documento antes de extrair.",
      }),
    );
    await expect(callerFor(TENANT).extractions.start({ documentId: DOC_ID })).rejects.toMatchObject(
      { code: "BAD_REQUEST" },
    );
  });

  // The input schema is the first guard: a non-uuid never reaches the service.
  it("refuses an input that is not a uuid before calling the service", async () => {
    await expect(
      callerFor(TENANT).extractions.start({ documentId: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(service.startExtraction).not.toHaveBeenCalled();
  });
});

describe("extractions.get", () => {
  it("reads the view under the caller's own tenant", async () => {
    service.getExtractionView.mockResolvedValue({ status: "revisar", problems: [] });

    const out = await callerFor(TENANT).extractions.get({ documentId: DOC_ID });

    expect(out).toEqual({ status: "revisar", problems: [] });
    expect(service.getExtractionView).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: TENANT, userId: "user-1" },
      DOC_ID,
    );
  });

  it("surfaces a not-found document as NOT_FOUND", async () => {
    service.getExtractionView.mockRejectedValue(
      new TRPCError({ code: "NOT_FOUND", message: "Documento não encontrado." }),
    );
    await expect(callerFor(TENANT).extractions.get({ documentId: DOC_ID })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("extractions.correct", () => {
  it("hands the payload to the service under the caller's tenant", async () => {
    service.correctExtraction.mockResolvedValue({
      extractionId: EXTRACTION_ID,
      resolvedJobs: 1,
    });

    const data = { numero: "FT 1" };
    const out = await callerFor(TENANT).extractions.correct({ documentId: DOC_ID, data });

    expect(out).toEqual({ extractionId: EXTRACTION_ID, resolvedJobs: 1 });
    expect(service.correctExtraction).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: TENANT, userId: "user-1" },
      { documentId: DOC_ID, data },
    );
  });

  it("surfaces the full-validity gate as BAD_REQUEST", async () => {
    service.correctExtraction.mockRejectedValue(
      new TRPCError({ code: "BAD_REQUEST", message: "A correção ainda tem campos inválidos." }),
    );
    await expect(
      callerFor(TENANT).extractions.correct({ documentId: DOC_ID, data: {} }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a payload that is not a JSON object", async () => {
    await expect(
      callerFor(TENANT).extractions.correct({
        documentId: DOC_ID,
        data: "não é um objeto" as unknown as Record<string, unknown>,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(service.correctExtraction).not.toHaveBeenCalled();
  });
});

describe("extractions.list", () => {
  it("lists only the caller's own tenant", async () => {
    service.listExtractionStatus.mockResolvedValue([{ documentId: DOC_ID, status: "done" }]);

    const out = await callerFor(TENANT).extractions.list();

    expect(out).toEqual([{ documentId: DOC_ID, status: "done" }]);
    expect(service.listExtractionStatus).toHaveBeenCalledWith(expect.anything(), TENANT);
  });
});
