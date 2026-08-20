// api/trpc/routers/documents.router.test.ts
//
// Drives the REAL router through a caller, because the property under test is
// the WIRING: which failure becomes which TRPCError code, in which order, and
// with a pt-BR message a user can act on. S3 (api/lib/storage.ts) and the
// DB-touching service (api/services/documents-crud.ts) are both mocked —
// their own behaviour is proven in storage's own callers and in
// documents-crud.test.ts respectively, so mocking them here keeps this test
// honest about what it actually covers: the router, not the SQL or the S3
// call shape.
//
// object-keys.assertOwnedKey is deliberately NOT mocked — it is
// dependency-free and cheap, and the whole point of the first test below is
// that the REAL predicate runs before headDocument is ever reached.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const storage = vi.hoisted(() => ({
  createPresignedUploadUrl: vi.fn(),
  headDocument: vi.fn(),
  getDocumentBytes: vi.fn(),
}));

vi.mock("../../lib/storage", () => ({
  createPresignedUploadUrl: storage.createPresignedUploadUrl,
  headDocument: storage.headDocument,
  getDocumentBytes: storage.getDocumentBytes,
  // Added when reports.router.ts joined the root router: a whole-module mock
  // must export everything the module graph imports, and the freeze path
  // (decisions §5.1) pulls these three from api/lib/storage.ts.
  frozenReportKey: vi.fn(),
  putFrozenReport: vi.fn(),
  getFrozenReport: vi.fn(),
  deleteFrozenReport: vi.fn(),
  MAX_UPLOAD_BYTES: 26_214_400,
  REQUIRED_CONTENT_TYPE: "application/pdf",
}));

const crud = vi.hoisted(() => ({
  assertReferencesOwnedByTenant: vi.fn(),
  insertDocumentIdempotent: vi.fn(),
  listDocuments: vi.fn(),
}));

vi.mock("../../services/documents-crud", () => crud);

// The detection service (api/detection/*, api/services/detection-service.ts)
// is proven in its own suites — this router test only proves the WIRING:
// which input reaches which service call, and that the service's return
// value is what the client gets back.
const detectionService = vi.hoisted(() => ({
  runDetection: vi.fn(),
  applyDetectionResult: vi.fn(),
  setDocumentTypeManually: vi.fn(),
}));

vi.mock("../../services/detection-service", () => detectionService);

const relay = vi.hoisted(() => ({ enqueueRelayJob: vi.fn() }));
vi.mock("../../lib/relay", () => relay);

const classifyJob = vi.hoisted(() => ({ loadClassifiableTypes: vi.fn() }));
vi.mock("../../detection/classify-job", () => classifyJob);

const { appRouter } = await import("../router");

const TENANT = "org-1";
const OTHER_TENANT = "org-2";
const DOC_ID = "22222222-2222-4222-8222-222222222222";
const DOC_TYPE_ID = "55555555-5555-4555-8555-555555555555";
const REPORT_JOB_ID = "44444444-4444-4444-8444-444444444444";

function callerFor(tenantId: string) {
  return appRouter.createCaller({ tenantId, userId: "user-1", role: "member" });
}

beforeEach(() => {
  storage.createPresignedUploadUrl.mockReset();
  storage.headDocument.mockReset();
  storage.getDocumentBytes.mockReset();
  crud.assertReferencesOwnedByTenant.mockReset().mockResolvedValue(undefined);
  crud.insertDocumentIdempotent.mockReset();
  crud.listDocuments.mockReset();
  detectionService.runDetection.mockReset();
  detectionService.applyDetectionResult.mockReset();
  detectionService.setDocumentTypeManually.mockReset();
  relay.enqueueRelayJob.mockReset();
  classifyJob.loadClassifiableTypes.mockReset();
});

describe("documents.documentTypes", () => {
  it("maps the tenant's classifiable types to {id, label} for the dropdown", async () => {
    classifyJob.loadClassifiableTypes.mockResolvedValue([
      { documentTypeId: DOC_TYPE_ID, label: "Toysmith / Nota Fiscal", hints: ["TOYSMITH"] },
    ]);

    const out = await callerFor(TENANT).documents.documentTypes();

    expect(out).toEqual([{ id: DOC_TYPE_ID, label: "Toysmith / Nota Fiscal" }]);
    expect(classifyJob.loadClassifiableTypes).toHaveBeenCalledWith(expect.anything(), TENANT);
  });
});

describe("documents.presignUpload", () => {
  it("mints an upload for the caller's own tenant", async () => {
    storage.createPresignedUploadUrl.mockResolvedValue({
      url: "https://signed.invalid/post",
      key: `${TENANT}/uuid.pdf`,
      fields: { "Content-Type": "application/pdf" },
    });

    const out = await callerFor(TENANT).documents.presignUpload();

    expect(storage.createPresignedUploadUrl).toHaveBeenCalledWith(TENANT);
    expect(out.key).toBe(`${TENANT}/uuid.pdf`);
  });
});

describe("documents.confirmUpload", () => {
  // Catches: trusting a client-supplied key without re-checking ownership.
  // The key belongs to another tenant's prefix; the router must refuse
  // before ever calling headDocument.
  it("refuses a key outside the caller's own tenant prefix", async () => {
    await expect(
      callerFor(TENANT).documents.confirmUpload({ key: `${OTHER_TENANT}/x.pdf` }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(storage.headDocument).not.toHaveBeenCalled();
  });

  it("reports NOT_FOUND when the object never landed in S3", async () => {
    storage.headDocument.mockResolvedValue(null);
    await expect(
      callerFor(TENANT).documents.confirmUpload({ key: `${TENANT}/x.pdf` }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(crud.insertDocumentIdempotent).not.toHaveBeenCalled();
  });

  it("refuses a stored object whose content type is not application/pdf", async () => {
    storage.headDocument.mockResolvedValue({ size: 1000, contentType: "image/png" });
    await expect(
      callerFor(TENANT).documents.confirmUpload({ key: `${TENANT}/x.pdf` }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(crud.insertDocumentIdempotent).not.toHaveBeenCalled();
  });

  it("refuses an object over the 25MB cap", async () => {
    storage.headDocument.mockResolvedValue({
      size: 26_214_401,
      contentType: "application/pdf",
    });
    await expect(
      callerFor(TENANT).documents.confirmUpload({ key: `${TENANT}/x.pdf` }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a zero-byte object", async () => {
    storage.headDocument.mockResolvedValue({ size: 0, contentType: "application/pdf" });
    await expect(
      callerFor(TENANT).documents.confirmUpload({ key: `${TENANT}/x.pdf` }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("propagates a reference-ownership failure (e.g. another tenant's client_id)", async () => {
    storage.headDocument.mockResolvedValue({ size: 1000, contentType: "application/pdf" });
    crud.assertReferencesOwnedByTenant.mockRejectedValue(
      new TRPCError({ code: "BAD_REQUEST", message: "Cliente inválido." }),
    );
    await expect(
      callerFor(TENANT).documents.confirmUpload({
        key: `${TENANT}/x.pdf`,
        clientId: "11111111-1111-1111-1111-111111111111",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(crud.insertDocumentIdempotent).not.toHaveBeenCalled();
  });

  it("inserts the document once every check passes, and returns its row", async () => {
    const row = { id: "doc-1", s3Key: `${TENANT}/x.pdf` };
    storage.headDocument.mockResolvedValue({ size: 1000, contentType: "application/pdf" });
    crud.insertDocumentIdempotent.mockResolvedValue({ row, created: true });

    const out = await callerFor(TENANT).documents.confirmUpload({ key: `${TENANT}/x.pdf` });

    expect(out).toEqual(row);
    expect(crud.assertReferencesOwnedByTenant).toHaveBeenCalledOnce();
    expect(crud.insertDocumentIdempotent).toHaveBeenCalledOnce();
    const [, ctxArg, inputArg] = crud.insertDocumentIdempotent.mock.calls[0] as [
      unknown,
      { tenantId: string; userId: string },
      { s3Key: string; byteSize: number },
    ];
    expect(ctxArg).toEqual({ tenantId: TENANT, userId: "user-1" });
    expect(inputArg).toMatchObject({ s3Key: `${TENANT}/x.pdf`, byteSize: 1000 });
  });
});

describe("documents.list", () => {
  it("scopes to the caller's own tenant", async () => {
    const rows = [{ id: "doc-1" }];
    crud.listDocuments.mockResolvedValue(rows);

    const out = await callerFor(TENANT).documents.list();

    expect(out).toBe(rows);
    expect(crud.listDocuments).toHaveBeenCalledWith(expect.anything(), TENANT);
  });
});

describe("documents.detect", () => {
  it("passes the input document id and the caller's tenant/user through to the service", async () => {
    detectionService.runDetection.mockResolvedValue({
      outcome: "hint",
      documentTypeId: DOC_TYPE_ID,
    });

    const out = await callerFor(TENANT).documents.detect({ documentId: DOC_ID });

    expect(out).toEqual({ outcome: "hint", documentTypeId: DOC_TYPE_ID });
    expect(detectionService.runDetection).toHaveBeenCalledOnce();
    const [depsArg, ctxArg, documentIdArg] = detectionService.runDetection.mock.calls[0] as [
      { enqueue: unknown; fetchPdf: unknown },
      { tenantId: string; userId: string },
      string,
    ];
    expect(ctxArg).toEqual({ tenantId: TENANT, userId: "user-1" });
    expect(documentIdArg).toBe(DOC_ID);
    expect(depsArg.enqueue).toBe(relay.enqueueRelayJob);
    expect(depsArg.fetchPdf).toBe(storage.getDocumentBytes);
  });

  it("propagates a NOT_FOUND from the service unchanged", async () => {
    detectionService.runDetection.mockRejectedValue(
      new TRPCError({ code: "NOT_FOUND", message: "Documento não encontrado." }),
    );
    await expect(callerFor(TENANT).documents.detect({ documentId: DOC_ID })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("documents.applyDetection", () => {
  it("resolves a finished tier-2 job for the caller's own tenant", async () => {
    detectionService.applyDetectionResult.mockResolvedValue({
      outcome: "applied",
      documentTypeId: DOC_TYPE_ID,
    });

    const out = await callerFor(TENANT).documents.applyDetection({ jobId: REPORT_JOB_ID });

    expect(out).toEqual({ outcome: "applied", documentTypeId: DOC_TYPE_ID });
    expect(detectionService.applyDetectionResult).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: TENANT, userId: "user-1" },
      REPORT_JOB_ID,
    );
  });
});

describe("documents.setDocumentType", () => {
  it("calls the service with the caller's tenant and returns ok", async () => {
    detectionService.setDocumentTypeManually.mockResolvedValue(undefined);

    const out = await callerFor(TENANT).documents.setDocumentType({
      documentId: DOC_ID,
      documentTypeId: DOC_TYPE_ID,
    });

    expect(out).toEqual({ ok: true });
    expect(detectionService.setDocumentTypeManually).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: TENANT, userId: "user-1" },
      DOC_ID,
      DOC_TYPE_ID,
    );
  });

  it("propagates a BAD_REQUEST the service raises for an invalid documentTypeId", async () => {
    detectionService.setDocumentTypeManually.mockRejectedValue(
      new TRPCError({ code: "BAD_REQUEST", message: "Tipo de documento inválido." }),
    );
    await expect(
      callerFor(TENANT).documents.setDocumentType({
        documentId: DOC_ID,
        documentTypeId: "99999999-9999-4999-8999-999999999999",
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("the procedure tier", () => {
  it("refuses every documents procedure for an unauthenticated caller", async () => {
    const caller = appRouter.createCaller({ tenantId: null, userId: null, role: null });
    await expect(caller.documents.presignUpload()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(caller.documents.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.documents.confirmUpload({ key: "x/y.pdf" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(caller.documents.detect({ documentId: DOC_ID })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(caller.documents.applyDetection({ jobId: REPORT_JOB_ID })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      caller.documents.setDocumentType({ documentId: DOC_ID, documentTypeId: DOC_TYPE_ID }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(caller.documents.documentTypes()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
