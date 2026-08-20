// api/trpc/routers/documents.router.ts
//
// The upload + detection slice (decisions §8, §12.5, §3.3, §12.2). Procedures:
//
//   presignUpload    — mints an S3 key under the caller's tenant prefix and a
//                      POST policy for it. No input: the client names nothing.
//   confirmUpload    — re-proves ownership of the key the client claims to
//                      have uploaded to, HEADs the object (never trusts the
//                      client's own account of size/type), and inserts the
//                      documents row. Idempotent on s3_key — safe to retry.
//   list             — the tenant's documents, newest first.
//   detect           — tier 1 (substring hint match) synchronously; falls
//                      through to enqueueing tier 2 (model classification via
//                      the relay) when tier 1 misses.
//   applyDetection   — resolves a finished tier-2 job onto its document.
//   setDocumentType  — tier 3, the always-present, always-correctable
//                      dropdown (§3.3).
//
// This router stays thin. DB access lives in api/services/documents-crud.ts
// and api/services/detection-service.ts so it can be unit-tested against a
// fake db handle the way the rest of this codebase's services are; S3 access
// lives in api/lib/storage.ts. All are mocked in this router's own test — the
// property under test here is the WIRING (which error becomes which
// TRPCError, in which order), not the SQL or the S3 call shape, which are
// covered where they live.

import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../procedures";
import { db } from "../../db/client";
import { ConfirmUploadInput } from "../../../shared/validation/document-schemas";
import {
  DetectInput,
  ApplyDetectionInput,
  SetDocumentTypeInput,
} from "../../../shared/validation/detection-schemas";
import { assertOwnedKey, ObjectKeyError } from "../../lib/object-keys";
import {
  createPresignedUploadUrl,
  getDocumentBytes,
  headDocument,
  MAX_UPLOAD_BYTES,
  REQUIRED_CONTENT_TYPE,
} from "../../lib/storage";
import {
  assertReferencesOwnedByTenant,
  insertDocumentIdempotent,
  listDocuments,
} from "../../services/documents-crud";
import {
  applyDetectionResult,
  runDetection,
  setDocumentTypeManually,
} from "../../services/detection-service";
import { loadClassifiableTypes } from "../../detection/classify-job";
import { enqueueRelayJob } from "../../lib/relay";

export const documentsRouter = router({
  presignUpload: protectedProcedure.mutation(async ({ ctx }) => {
    return createPresignedUploadUrl(ctx.tenantId);
  }),

  confirmUpload: protectedProcedure.input(ConfirmUploadInput).mutation(async ({ ctx, input }) => {
    try {
      assertOwnedKey(input.key, ctx.tenantId, "key");
    } catch (err) {
      if (err instanceof ObjectKeyError) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Você não tem permissão para confirmar este arquivo.",
        });
      }
      throw err;
    }

    const head = await headDocument(input.key);
    if (head === null) {
      // Ordinary outcome, not a fault: the POST may still be in flight, may
      // have failed client-side, or the client may be replaying a stale key.
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Arquivo não encontrado. Envie o PDF novamente.",
      });
    }
    if (head.contentType !== REQUIRED_CONTENT_TYPE) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "O arquivo enviado precisa ser um PDF.",
      });
    }
    if (head.size <= 0 || head.size > MAX_UPLOAD_BYTES) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "O arquivo excede o tamanho máximo permitido (25MB).",
      });
    }

    await assertReferencesOwnedByTenant(db, ctx.tenantId, {
      clientId: input.clientId ?? null,
      documentTypeId: input.documentTypeId ?? null,
    });

    const { row } = await insertDocumentIdempotent(
      db,
      { tenantId: ctx.tenantId, userId: ctx.userId },
      {
        s3Key: input.key,
        byteSize: head.size,
        clientId: input.clientId ?? null,
        documentTypeId: input.documentTypeId ?? null,
      },
    );

    return row;
  }),

  list: protectedProcedure.query(async ({ ctx }) => {
    return listDocuments(db, ctx.tenantId);
  }),

  // Powers tier 3's dropdown (§3.3) — every active document type the tenant
  // has configured, labelled the same way tier 2's job menu is
  // (`classify-job.ts`'s `loadClassifiableTypes`), so the option a human picks
  // and the option the model could have picked are the same list.
  documentTypes: protectedProcedure.query(async ({ ctx }) => {
    const types = await loadClassifiableTypes(db, ctx.tenantId);
    return types.map((t) => ({ id: t.documentTypeId, label: t.label }));
  }),

  // Three tiers, decisions §3.3/§12.2. `detect` runs tier 1 synchronously and
  // falls through to enqueueing tier 2; `applyDetection` resolves a finished
  // tier-2 job onto its document; `setDocumentType` is tier 3, the always-
  // present, always-correctable dropdown. All three re-prove document
  // ownership against `ctx.tenantId` inside detection-service.ts — none of
  // them trust the id the client sent beyond using it as a lookup key.

  detect: protectedProcedure.input(DetectInput).mutation(async ({ ctx, input }) => {
    return runDetection(
      { db, enqueue: enqueueRelayJob, fetchPdf: getDocumentBytes },
      { tenantId: ctx.tenantId, userId: ctx.userId },
      input.documentId,
    );
  }),

  applyDetection: protectedProcedure.input(ApplyDetectionInput).mutation(async ({ ctx, input }) => {
    return applyDetectionResult(db, { tenantId: ctx.tenantId, userId: ctx.userId }, input.jobId);
  }),

  setDocumentType: protectedProcedure
    .input(SetDocumentTypeInput)
    .mutation(async ({ ctx, input }) => {
      await setDocumentTypeManually(
        db,
        { tenantId: ctx.tenantId, userId: ctx.userId },
        input.documentId,
        input.documentTypeId,
      );
      return { ok: true as const };
    }),
});
