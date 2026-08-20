// api/trpc/routers/reports.router.ts
//
// Report drafts and publication (decisions §5). Procedures:
//
//   list / get      — the tenant's reports and one report's full draft state.
//   clients         — the picker for "who is this report about" (§2).
//   create          — pins a template VERSION, never a template (§5.3).
//   roleOptions     — extractions whose document matches a role's type.
//   attach / detach — the named-role join (§3.2).
//   updateSlot      — a human edit; sets `edited: true` (§5.2).
//   upgradeVersion  — the explicit "[ atualizar para v2 ]" (§5.3).
//   startAnalysis   — hop 2; §5.2's "regerar mesmo assim" is the `slugs` list.
//   verify          — §12.13's adversarial pass over the prose.
//   render          — the live draft, or the FROZEN html for a published one.
//   publish         — the freeze protocol (api/services/report-publish.ts).
//
// OWNERSHIP IS NOT RE-PROVEN HERE, IT IS RE-PROVEN THERE — the same rule
// extractions.router.ts states. Every service entry point starts by loading
// the report (or the version, through `assertVersionVisible`) under
// `ctx.tenantId`, so a uuid from the browser is a lookup key on a scoped read
// and never a permission. Doing it twice would put the rule in two places and
// make the weaker copy authoritative the first time someone edits one.

import { router, protectedProcedure } from "../procedures";
import { db } from "../../db/client";
import {
  AttachDocumentInput,
  CreateReportInput,
  DetachDocumentInput,
  ReportIdInput,
  RoleOptionsInput,
  StartAnalysisInput,
  UpdateSlotInput,
  UpgradeReportVersionInput,
} from "../../../shared/validation/report-schemas";
import {
  attachDocument,
  createReport,
  detachDocument,
  getReport,
  listClients,
  listReports,
  roleOptions,
  updateSlot,
  upgradeReportVersion,
} from "../../services/report-service";
import { publishReport, renderReport, type PublishDeps } from "../../services/report-publish";
import { startAnalysis } from "../../services/analysis-service";
import { startVerify } from "../../services/verify-service";
import { enqueueRelayJob } from "../../lib/relay";
import {
  deleteFrozenReport,
  frozenReportKey,
  getFrozenReport,
  putFrozenReport,
} from "../../lib/storage";

/** S3 access is injected rather than imported by the service, so the freeze
 * protocol can be tested without an AWS client — the same shape
 * extraction-service.ts uses for `enqueue` / `fetchPdf`. */
const publishDeps: PublishDeps = {
  db,
  frozenKey: frozenReportKey,
  putFrozen: putFrozenReport,
  getFrozen: getFrozenReport,
  deleteFrozen: deleteFrozenReport,
};

export const reportsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return listReports(db, ctx.tenantId);
  }),

  clients: protectedProcedure.query(async ({ ctx }) => {
    return listClients(db, ctx.tenantId);
  }),

  get: protectedProcedure.input(ReportIdInput).query(async ({ ctx, input }) => {
    return getReport(db, ctx.tenantId, input.reportId);
  }),

  create: protectedProcedure.input(CreateReportInput).mutation(async ({ ctx, input }) => {
    return createReport(db, { tenantId: ctx.tenantId, userId: ctx.userId }, input);
  }),

  roleOptions: protectedProcedure.input(RoleOptionsInput).query(async ({ ctx, input }) => {
    return roleOptions(db, ctx.tenantId, input.reportId, input.roleKey);
  }),

  attach: protectedProcedure.input(AttachDocumentInput).mutation(async ({ ctx, input }) => {
    return attachDocument(db, { tenantId: ctx.tenantId, userId: ctx.userId }, input);
  }),

  detach: protectedProcedure.input(DetachDocumentInput).mutation(async ({ ctx, input }) => {
    return detachDocument(db, { tenantId: ctx.tenantId, userId: ctx.userId }, input);
  }),

  updateSlot: protectedProcedure.input(UpdateSlotInput).mutation(async ({ ctx, input }) => {
    return updateSlot(db, { tenantId: ctx.tenantId, userId: ctx.userId }, input);
  }),

  /**
   * §4 hop 2. The prose, for every slot a human has not edited — or for
   * exactly the slugs named, which IS §5.2's "regerar mesmo assim".
   *
   * A MUTATION that returns a job id, like every other paid hop: the answer
   * arrives ~30s later through `jobs.poll`, and the collector merges it.
   */
  startAnalysis: protectedProcedure.input(StartAnalysisInput).mutation(async ({ ctx, input }) => {
    return startAnalysis(
      { db, enqueue: enqueueRelayJob },
      { tenantId: ctx.tenantId, userId: ctx.userId },
      input,
    );
  }),

  /** §12.13 — the adversarial pass over this report's prose. A different model
   * than the one that wrote it, and it never rewrites: a refuted claim is a
   * flag a person resolves. */
  verify: protectedProcedure.input(ReportIdInput).mutation(async ({ ctx, input }) => {
    return startVerify(
      { db, enqueue: enqueueRelayJob },
      { tenantId: ctx.tenantId, userId: ctx.userId },
      { target: "analysis", reportId: input.reportId },
    );
  }),

  upgradeVersion: protectedProcedure
    .input(UpgradeReportVersionInput)
    .mutation(async ({ ctx, input }) => {
      return upgradeReportVersion(db, { tenantId: ctx.tenantId, userId: ctx.userId }, input);
    }),

  render: protectedProcedure.input(ReportIdInput).query(async ({ ctx, input }) => {
    return renderReport(publishDeps, ctx.tenantId, input.reportId);
  }),

  publish: protectedProcedure.input(ReportIdInput).mutation(async ({ ctx, input }) => {
    return publishReport(
      publishDeps,
      { tenantId: ctx.tenantId, userId: ctx.userId },
      input.reportId,
    );
  }),
});
