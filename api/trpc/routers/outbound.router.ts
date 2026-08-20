// api/trpc/routers/outbound.router.ts
//
// The outbound-template authoring surface (decisions §3.2, §5.3, §12.4):
//
//   list        — the tenant's templates plus the system ones, with "v3".
//   get         — one template, its versions, and the latest version's source.
//   create      — a named, empty template. Versions come from saveVersion.
//   saveVersion — validates and writes version N+1. IMMUTABLE; no update path.
//   preview     — renders the UNSAVED textarea against the calibration
//                 fixtures and hands back HTML.
//
// PREVIEW RENDERS SERVER-SIDE, ON PURPOSE (see api/render/handlebars.ts's
// header). The client receives finished HTML and drops it into a SANDBOXED
// `<iframe srcdoc>` (§12.4). Shipping Handlebars to the browser would put a
// second compiler in the system, and a second compiler is a second answer to
// "what will this document say".
//
// SAVE RUNS IN ONE TRANSACTION. `insertTemplateVersion` reads MAX(version) and
// then inserts; straddling that pair across two connections is how two authors
// both write version 4. The unique index still refuses the loser, but inside a
// transaction the read is the one this write is ordered against.
//
// This router stays thin — the same split as documents/calibration/extractions.
// Everything that touches the DB lives in
// api/services/outbound-template-service.ts.

import { router, protectedProcedure } from "../procedures";
import { db } from "../../db/client";
import {
  CreateOutboundTemplateInput,
  OutboundTemplateIdInput,
  PreviewTemplateInput,
  SaveTemplateVersionInput,
} from "../../../shared/validation/outbound-schemas";
import {
  createTemplate,
  getTemplate,
  listTemplates,
  previewTemplate,
  saveVersion,
} from "../../services/outbound-template-service";

export const outboundRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return listTemplates(db, ctx.tenantId);
  }),

  get: protectedProcedure.input(OutboundTemplateIdInput).query(async ({ ctx, input }) => {
    return getTemplate(db, ctx.tenantId, input.templateId);
  }),

  create: protectedProcedure.input(CreateOutboundTemplateInput).mutation(async ({ ctx, input }) => {
    return createTemplate(db, { tenantId: ctx.tenantId, userId: ctx.userId }, input);
  }),

  saveVersion: protectedProcedure
    .input(SaveTemplateVersionInput)
    .mutation(async ({ ctx, input }) => {
      return db.transaction(async (tx) =>
        saveVersion(tx, { tenantId: ctx.tenantId, userId: ctx.userId }, input),
      );
    }),

  preview: protectedProcedure.input(PreviewTemplateInput).mutation(async ({ ctx, input }) => {
    return previewTemplate(db, ctx.tenantId, input);
  }),
});
