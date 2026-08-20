// api/trpc/routers/extractions.router.ts
//
// Hop 1 and its repair screen (decisions §4, §4.2). Procedures:
//
//   start   — enqueues the extraction, or reports that a cached one already
//             answers (§12.8's `unique(s3_key, calibration_rev)`).
//   get     — everything the `revisar` screen renders: the frozen field tree,
//             the values, and the per-field problems, re-computed on read.
//   correct — the human's repaired payload. Full validity or nothing; then
//             the `revisar` job is closed.
//   list    — one status per document, for the documents-page column.
//
// This router stays thin, the same split as documents.router.ts and
// calibration.router.ts: everything that touches the DB or S3 lives in
// api/services/extraction-service.ts, and the property this file's own test
// covers is the WIRING — which input reaches which service call, under which
// tenant, and which failure becomes which TRPCError.
//
// OWNERSHIP IS NOT RE-PROVEN HERE, IT IS RE-PROVEN THERE, and deliberately so:
// every service entry point below starts by loading the document under
// `ctx.tenantId`, so a uuid from the browser is a lookup key on a scoped read
// and never a permission. Doing it twice would put the rule in two places and
// make the weaker copy authoritative the first time someone edits one.

import { router, protectedProcedure } from "../procedures";
import { db } from "../../db/client";
import {
  CorrectExtractionInput,
  GetExtractionInput,
  StartExtractionInput,
} from "../../../shared/validation/extraction-schemas";
import {
  correctExtraction,
  getExtractionView,
  listExtractionStatus,
  startExtraction,
} from "../../services/extraction-service";
import { enqueueRelayJob } from "../../lib/relay";
import { getDocumentBytes } from "../../lib/storage";

export const extractionsRouter = router({
  start: protectedProcedure.input(StartExtractionInput).mutation(async ({ ctx, input }) => {
    return startExtraction(
      { db, enqueue: enqueueRelayJob, fetchPdf: getDocumentBytes },
      { tenantId: ctx.tenantId, userId: ctx.userId },
      input.documentId,
    );
  }),

  get: protectedProcedure.input(GetExtractionInput).query(async ({ ctx, input }) => {
    return getExtractionView(db, { tenantId: ctx.tenantId, userId: ctx.userId }, input.documentId);
  }),

  correct: protectedProcedure.input(CorrectExtractionInput).mutation(async ({ ctx, input }) => {
    return correctExtraction(db, { tenantId: ctx.tenantId, userId: ctx.userId }, input);
  }),

  list: protectedProcedure.query(async ({ ctx }) => {
    return listExtractionStatus(db, ctx.tenantId);
  }),
});
