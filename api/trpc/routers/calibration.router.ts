// api/trpc/routers/calibration.router.ts
//
// The Calibrate slice (decisions §3.1, §3.3, §12.8). Procedures:
//
//   providers     — the tenant's providers, for the picker.
//   propose       — enqueues the proposal hop against a sample document and
//                   returns the `report_jobs.id` to poll.
//   pollProposal  — the SAME backstop `jobs.poll` runs
//                   (api/collector/poll-job.ts), plus the interpretation of a
//                   settled row as a draft. Stores nothing.
//   freeze        — creates/updates provider + document type + extract
//                   template + field list + golden fixture, in ONE transaction.
//   listTemplates — what has already been frozen.
//   getTemplate   — one template with its field list as a tree.
//
// This router stays thin, the same split as documents.router.ts: everything
// that touches the DB or S3 lives in api/services/calibration-service.ts, and
// the property this file's own test covers is the WIRING — which input reaches
// which service call, under which tenant.

import { router, protectedProcedure } from "../procedures";
import { db } from "../../db/client";
import { TRPCError } from "@trpc/server";
import {
  FreezeCalibrationInput,
  GetTemplateInput,
  PollProposalInput,
  ProposeCalibrationInput,
} from "../../../shared/validation/calibration-schemas";
import {
  getTemplate,
  interpretProposalJob,
  listProviders,
  listTemplates,
  proposeCalibration,
} from "../../services/calibration-service";
import { freezeCalibration } from "../../services/calibration-freeze";
import { pollJobRow } from "../../collector/poll-job";
import { enqueueRelayJob } from "../../lib/relay";
import { getDocumentBytes } from "../../lib/storage";

export const calibrationRouter = router({
  providers: protectedProcedure.query(async ({ ctx }) => {
    return listProviders(db, ctx.tenantId);
  }),

  propose: protectedProcedure.input(ProposeCalibrationInput).mutation(async ({ ctx, input }) => {
    return proposeCalibration(
      { db, enqueue: enqueueRelayJob, fetchPdf: getDocumentBytes },
      { tenantId: ctx.tenantId, userId: ctx.userId },
      input,
    );
  }),

  // A query, not a mutation: the UI polls it on an interval and react-query
  // polls queries. Defensible for the same reason `jobs.poll` is — the only
  // write it can trigger is the collector's own compare-and-set.
  pollProposal: protectedProcedure.input(PollProposalInput).query(async ({ ctx, input }) => {
    const row = await pollJobRow(ctx.tenantId, input.jobId);
    if (row === undefined) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Proposta não encontrada." });
    }
    return interpretProposalJob(row);
  }),

  // ONE transaction: a rev bump with no fields, or fields with no template, is
  // not a state this system has a repair path for (§12.8 has no versioning to
  // roll back to).
  freeze: protectedProcedure.input(FreezeCalibrationInput).mutation(async ({ ctx, input }) => {
    return db.transaction(async (tx) =>
      freezeCalibration(tx, { tenantId: ctx.tenantId, userId: ctx.userId }, input),
    );
  }),

  listTemplates: protectedProcedure.query(async ({ ctx }) => {
    return listTemplates(db, ctx.tenantId);
  }),

  getTemplate: protectedProcedure.input(GetTemplateInput).query(async ({ ctx, input }) => {
    return getTemplate(db, ctx.tenantId, input.templateId);
  }),
});
