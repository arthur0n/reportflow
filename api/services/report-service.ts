// api/services/report-service.ts
//
// The DRAFT half of a report (decisions §5). Publishing lives next door in
// report-publish.ts — the same split, for the same reason, as
// calibration-service / calibration-freeze: everything here reads or edits a
// mutable draft, everything there produces the immutable artifact.
//
// THREE RULES THIS FILE ENFORCES.
//
// 1. `template_version_id` GOES THROUGH `assertVersionVisible`. The version row
//    carries no tenant_id of its own (drizzle/tables/outbound.ts), so a uuid
//    from the browser is the ONLY thing naming it and nothing else in the
//    write path can tell whose template it belongs to. That call is the whole
//    guard — see api/db/outbound-access.ts.
//
// 2. A DOCUMENT IS BOUND BY ROLE, AND THE ROLE DECIDES WHAT FITS (§3.2). The
//    role names a `document_type_id`; an extraction whose document is of a
//    different type is refused. `docs[0]` cannot tell an invoice from a
//    contract, and a role that accepts anything is a role that has stopped
//    meaning something.
//
// 3. A FROZEN REPORT IS READ-ONLY. `frozen_at IS NOT NULL` IS the published
//    state (drizzle/tables/pipeline.ts), so every mutation below refuses on
//    it rather than trusting a status column that could disagree.

import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import {
  clients,
  documentTypes,
  documents,
  extractions,
  reportDocuments,
  reportJobs,
  reports,
} from "../../drizzle/schema";
import type { DbLike } from "../collector/job-state";
import { assertVersionVisible, getOutboundTemplateVersion } from "../db/outbound-access";
import { withSystemFields } from "../db/scope";
import {
  parseReportContent,
  withSlot,
  type RefutedClaim,
  type ReportContent,
} from "../render/report-content";
import {
  buildReportContext,
  todayInSaoPaulo,
  type BuiltContext,
  type ReportMeta,
  type RoleBinding,
} from "../render/report-context";
import { parseRoles, parseSlots } from "./outbound-template-service";
import type { RoleDeclarationT, SlotDeclarationT } from "../../shared/validation/outbound-schemas";
import type {
  AttachDocumentInputT,
  CreateReportInputT,
  UpdateSlotInputT,
} from "../../shared/validation/report-schemas";

export interface ReportCtx {
  readonly tenantId: string;
  readonly userId: string;
}

type ReportRow = typeof reports.$inferSelect;

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

export async function loadOwnedReport(
  dbHandle: DbLike,
  tenantId: string,
  reportId: string,
): Promise<ReportRow> {
  const [row] = await dbHandle
    .select()
    .from(reports)
    .where(and(eq(reports.id, reportId), eq(reports.tenantId, tenantId), isNull(reports.deletedAt)))
    .limit(1);
  if (row === undefined) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Relatório não encontrado." });
  }
  return row;
}

/** Published reports are immutable (§5.1). One message, one place. */
function assertDraft(report: ReportRow): void {
  if (report.frozenAt !== null) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "Este relatório já foi publicado e não pode mais ser alterado.",
    });
  }
}

// ---------------------------------------------------------------------------
// The bundle every read and both renders start from
// ---------------------------------------------------------------------------

export interface AttachedDocument {
  readonly extractionId: string;
  readonly documentId: string;
  readonly fileName: string | null;
  readonly sortOrder: number;
  readonly data: unknown;
}

export interface ReportBundle {
  readonly report: ReportRow;
  readonly version: { readonly id: string; readonly version: number; readonly html: string };
  readonly roles: readonly RoleDeclarationT[];
  readonly slots: readonly SlotDeclarationT[];
  readonly content: ReportContent;
  readonly attached: ReadonlyMap<string, readonly AttachedDocument[]>;
  readonly clientName: string | null;
}

/**
 * Everything a draft needs, in one place, read under the caller's tenant.
 *
 * The version is fetched through `getOutboundTemplateVersion`, which joins back
 * to the parent template for visibility — the same path `assertVersionVisible`
 * guards on the write side. Reading it any other way would be a second, weaker
 * answer to "may this tenant see this template's HTML".
 */
export async function loadReportBundle(
  dbHandle: DbLike,
  tenantId: string,
  reportId: string,
): Promise<ReportBundle> {
  const report = await loadOwnedReport(dbHandle, tenantId, reportId);
  const version = await getOutboundTemplateVersion(dbHandle, tenantId, report.templateVersionId);
  if (version === undefined) {
    // Reachable only if the template was deleted out from under a draft.
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "A versão do modelo deste relatório não está mais disponível.",
    });
  }

  const rows = await dbHandle
    .select({
      roleKey: reportDocuments.roleKey,
      sortOrder: reportDocuments.sortOrder,
      extractionId: extractions.id,
      documentId: documents.id,
      fileName: documents.fileName,
      data: extractions.data,
    })
    .from(reportDocuments)
    .innerJoin(extractions, eq(extractions.id, reportDocuments.extractionId))
    .innerJoin(documents, eq(documents.id, extractions.documentId))
    .where(and(eq(reportDocuments.reportId, reportId), eq(reportDocuments.tenantId, tenantId)))
    .orderBy(asc(reportDocuments.roleKey), asc(reportDocuments.sortOrder));

  const attached = new Map<string, AttachedDocument[]>();
  for (const row of rows) {
    const list = attached.get(row.roleKey) ?? [];
    list.push({
      extractionId: row.extractionId,
      documentId: row.documentId,
      fileName: row.fileName,
      sortOrder: row.sortOrder,
      data: row.data,
    });
    attached.set(row.roleKey, list);
  }

  let clientName: string | null = null;
  if (report.clientId !== null) {
    const [client] = await dbHandle
      .select({ name: clients.name })
      .from(clients)
      .where(and(eq(clients.id, report.clientId), eq(clients.tenantId, tenantId)))
      .limit(1);
    clientName = client?.name ?? null;
  }

  return {
    report,
    version: { id: version.id, version: version.version, html: version.html },
    roles: parseRoles(version.inputsJson),
    slots: parseSlots(version.slotsJson),
    content: parseReportContent(report.contentJson),
    attached,
    clientName,
  };
}

/** The bundle's bindings, in the shape `buildReportContext` takes. */
export function bindingsOf(bundle: ReportBundle): RoleBinding[] {
  return bundle.roles.map((role) => ({
    roleKey: role.key,
    extractions: (bundle.attached.get(role.key) ?? []).map((a) => ({
      id: a.extractionId,
      data: a.data,
    })),
  }));
}

/** Every extraction bound to this report, sorted — §12.6's ref_id half, and
 * the analysis verifier's ground-truth set. */
export function extractionIdsOf(bundle: ReportBundle): string[] {
  const ids: string[] = [];
  for (const list of bundle.attached.values()) {
    for (const item of list) {
      ids.push(item.extractionId);
    }
  }
  return ids.sort();
}

function metaFor(bundle: ReportBundle): ReportMeta {
  let n = 0;
  for (const list of bundle.attached.values()) {
    n += list.length;
  }
  return {
    titulo: bundle.report.title ?? "Relatório",
    cliente: bundle.clientName,
    emissao: todayInSaoPaulo(),
    n_documentos: n,
  };
}

/**
 * THE DETERMINISTIC HALF, from one bundle (§12.12b).
 *
 * ONE definition, because three callers now need the identical object and they
 * must not disagree about it: the render/publish path
 * (api/services/report-publish.ts), the analysis hop — which hands this to the
 * model AS ITS FACTS — and the analysis VERIFIER, which §12.13's own amendment
 * requires to see the same computed context the writer saw. A second builder
 * anywhere makes the verifier refute prose that was correct.
 */
export function reportContextOf(bundle: ReportBundle): BuiltContext {
  return buildReportContext({
    roles: bundle.roles,
    bindings: bindingsOf(bundle),
    meta: metaFor(bundle),
  });
}

// ---------------------------------------------------------------------------
// create / list / get
// ---------------------------------------------------------------------------

export async function createReport(
  dbHandle: DbLike,
  ctx: ReportCtx,
  input: CreateReportInputT,
): Promise<{ id: string }> {
  // FIRST, and not as one condition among several: everything after this line
  // treats `templateVersionId` as a value this tenant is allowed to name.
  await assertVersionVisible(dbHandle, input.templateVersionId, ctx.tenantId);

  if (input.clientId != null) {
    const [client] = await dbHandle
      .select({ id: clients.id })
      .from(clients)
      .where(
        and(
          eq(clients.id, input.clientId),
          eq(clients.tenantId, ctx.tenantId),
          isNull(clients.deletedAt),
        ),
      )
      .limit(1);
    if (client === undefined) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Cliente inválido." });
    }
  }

  const rows = await dbHandle
    .insert(reports)
    .values(
      withSystemFields({ userId: ctx.userId }, "create", {
        tenantId: ctx.tenantId,
        clientId: input.clientId ?? null,
        templateVersionId: input.templateVersionId,
        title: input.title ?? null,
        contentJson: { slots: {} },
      }),
    )
    .returning({ id: reports.id });
  const row = rows[0];
  if (row === undefined) {
    throw new Error("createReport: reports insert returned no row");
  }
  return { id: row.id };
}

export async function listReports(
  dbHandle: DbLike,
  tenantId: string,
): Promise<
  { id: string; title: string | null; clientName: string | null; frozenAt: string | null }[]
> {
  const rows = await dbHandle
    .select({
      id: reports.id,
      title: reports.title,
      clientName: clients.name,
      frozenAt: reports.frozenAt,
    })
    .from(reports)
    .leftJoin(clients, eq(clients.id, reports.clientId))
    .where(and(eq(reports.tenantId, tenantId), isNull(reports.deletedAt)))
    .orderBy(desc(reports.createdAt));
  return rows.map((r) => ({ ...r, clientName: r.clientName ?? null }));
}

/** The tenant's clients, for the report-creation picker. §2's vocabulary:
 * an ACCOUNT is the Clerk org, a CLIENT is the account's own customer. */
export async function listClients(
  dbHandle: DbLike,
  tenantId: string,
): Promise<{ id: string; name: string }[]> {
  return dbHandle
    .select({ id: clients.id, name: clients.name })
    .from(clients)
    .where(and(eq(clients.tenantId, tenantId), isNull(clients.deletedAt)))
    .orderBy(asc(clients.name));
}

export interface ReportDetail {
  readonly id: string;
  readonly title: string | null;
  readonly clientId: string | null;
  readonly clientName: string | null;
  readonly frozenAt: string | null;
  readonly frozenHtmlS3Key: string | null;
  readonly templateVersionId: string;
  readonly version: number;
  readonly roles: readonly (RoleDeclarationT & {
    readonly attached: readonly { extractionId: string; fileName: string | null }[];
  })[];
  readonly slots: readonly (SlotDeclarationT & {
    readonly text: string | null;
    readonly edited: boolean;
    /** §12.12c, advisory — numerals with no deterministic source, recorded
     * when the prose arrived. Publication recomputes and refuses. */
    readonly numeralFlags: readonly string[];
    /** §12.13, blocking — claims the verifier would not confirm. */
    readonly refuted: readonly RefutedClaim[];
    /** `null` = never verified, which is a different fact from "verified and
     * clean" and the only reason this is not derived from `refuted`. */
    readonly verifiedAt: string | null;
  })[];
  readonly missingRequiredRoles: readonly string[];
  /** The most recent hop of each kind for this report, so the screen can poll
   * one row instead of guessing (§4). */
  readonly analysisJob: ReportJobView | null;
  readonly verifyJob: ReportJobView | null;
}

export interface ReportJobView {
  readonly id: string;
  readonly status: string;
  readonly error: string | null;
}

export async function getReport(
  dbHandle: DbLike,
  tenantId: string,
  reportId: string,
): Promise<ReportDetail> {
  const bundle = await loadReportBundle(dbHandle, tenantId, reportId);
  const [analysisJob, verifyJob] = await Promise.all([
    latestReportJob(dbHandle, tenantId, reportId, "analyse"),
    latestReportJob(dbHandle, tenantId, reportId, "verify"),
  ]);
  const roles = bundle.roles.map((role) => ({
    ...role,
    attached: (bundle.attached.get(role.key) ?? []).map((a) => ({
      extractionId: a.extractionId,
      fileName: a.fileName,
    })),
  }));
  return {
    id: bundle.report.id,
    title: bundle.report.title,
    clientId: bundle.report.clientId,
    clientName: bundle.clientName,
    frozenAt: bundle.report.frozenAt,
    frozenHtmlS3Key: bundle.report.frozenHtmlS3Key,
    templateVersionId: bundle.version.id,
    version: bundle.version.version,
    roles,
    slots: bundle.slots.map((slot) => {
      const stored = bundle.content.slots[slot.slug];
      return {
        ...slot,
        text: stored?.text ?? null,
        edited: stored?.edited ?? false,
        numeralFlags: stored?.numeralFlags ?? [],
        refuted: stored?.refuted ?? [],
        verifiedAt: stored?.verifiedAt ?? null,
      };
    }),
    missingRequiredRoles: roles
      .filter((r) => r.required && r.attached.length === 0)
      .map((r) => r.key),
    analysisJob,
    verifyJob,
  };
}

/** The newest `analyse` / `verify` job for a report. `request` is never
 * selected: it is the system prompt, the facts and the model choice, and the
 * browser has no use for any of them (jobs.router.ts withholds it for the same
 * reason). */
async function latestReportJob(
  dbHandle: DbLike,
  tenantId: string,
  reportId: string,
  kind: "analyse" | "verify",
): Promise<ReportJobView | null> {
  const rows = await dbHandle
    .select({ id: reportJobs.id, status: reportJobs.status, error: reportJobs.error })
    .from(reportJobs)
    .where(
      and(
        eq(reportJobs.tenantId, tenantId),
        eq(reportJobs.reportId, reportId),
        eq(reportJobs.kind, kind),
      ),
    )
    .orderBy(desc(reportJobs.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// attach / detach — the named-role join (§3.2)
// ---------------------------------------------------------------------------

function requireRole(roles: readonly RoleDeclarationT[], roleKey: string): RoleDeclarationT {
  const role = roles.find((r) => r.key === roleKey);
  if (role === undefined) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `O papel "${roleKey}" não existe nesta versão do modelo.`,
    });
  }
  return role;
}

export async function attachDocument(
  dbHandle: DbLike,
  ctx: ReportCtx,
  input: AttachDocumentInputT,
): Promise<{ attached: number }> {
  const bundle = await loadReportBundle(dbHandle, ctx.tenantId, input.reportId);
  assertDraft(bundle.report);
  const role = requireRole(bundle.roles, input.roleKey);

  const [extraction] = await dbHandle
    .select({
      id: extractions.id,
      documentTypeId: documents.documentTypeId,
      typeName: documentTypes.name,
    })
    .from(extractions)
    .innerJoin(documents, eq(documents.id, extractions.documentId))
    .leftJoin(documentTypes, eq(documentTypes.id, documents.documentTypeId))
    .where(and(eq(extractions.id, input.extractionId), eq(extractions.tenantId, ctx.tenantId)))
    .limit(1);
  if (extraction === undefined) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Extração não encontrada." });
  }
  if (extraction.documentTypeId !== role.documentTypeId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        `O papel "${role.key}" exige ${role.provider} / ${role.documentType}, ` +
        `mas o documento é ${extraction.typeName ?? "de tipo não definido"}.`,
    });
  }

  const existing = bundle.attached.get(role.key) ?? [];
  if (role.cardinality === "one" && existing.length > 0) {
    // REPLACE, not refuse. A `one` role holds exactly one document by
    // definition, and what is being replaced is a BINDING — no human prose
    // dies here, so §5.2's "never silently destroy human work" does not
    // apply. Refusing would make "I picked the wrong invoice" a two-step
    // repair for no gain.
    await dbHandle
      .delete(reportDocuments)
      .where(
        and(
          eq(reportDocuments.reportId, input.reportId),
          eq(reportDocuments.tenantId, ctx.tenantId),
          eq(reportDocuments.roleKey, role.key),
        ),
      );
  }

  await dbHandle
    .insert(reportDocuments)
    .values(
      withSystemFields({ userId: ctx.userId }, "create", {
        tenantId: ctx.tenantId,
        reportId: input.reportId,
        extractionId: input.extractionId,
        roleKey: role.key,
        sortOrder: role.cardinality === "one" ? 0 : existing.length,
      }),
    )
    .onConflictDoNothing({
      target: [reportDocuments.reportId, reportDocuments.roleKey, reportDocuments.extractionId],
    });

  return { attached: role.cardinality === "one" ? 1 : existing.length + 1 };
}

export async function detachDocument(
  dbHandle: DbLike,
  ctx: ReportCtx,
  input: AttachDocumentInputT,
): Promise<{ ok: true }> {
  const report = await loadOwnedReport(dbHandle, ctx.tenantId, input.reportId);
  assertDraft(report);
  await dbHandle
    .delete(reportDocuments)
    .where(
      and(
        eq(reportDocuments.reportId, input.reportId),
        eq(reportDocuments.tenantId, ctx.tenantId),
        eq(reportDocuments.roleKey, input.roleKey),
        eq(reportDocuments.extractionId, input.extractionId),
      ),
    );
  return { ok: true };
}

/** Extractions this tenant already has whose document matches the role's
 * declared type — the dropdown the attach step offers. Extraction, not
 * document: hop 2 reads stored extraction JSON, never the PDF (§12.3), so a
 * document with no extraction has nothing to contribute yet. */
export async function roleOptions(
  dbHandle: DbLike,
  tenantId: string,
  reportId: string,
  roleKey: string,
): Promise<{ extractionId: string; fileName: string | null; createdAt: string }[]> {
  const bundle = await loadReportBundle(dbHandle, tenantId, reportId);
  const role = requireRole(bundle.roles, roleKey);
  return dbHandle
    .select({
      extractionId: extractions.id,
      fileName: documents.fileName,
      createdAt: extractions.createdAt,
    })
    .from(extractions)
    .innerJoin(documents, eq(documents.id, extractions.documentId))
    .where(
      and(
        eq(extractions.tenantId, tenantId),
        eq(documents.documentTypeId, role.documentTypeId),
        isNull(documents.deletedAt),
      ),
    )
    .orderBy(desc(extractions.createdAt));
}

// ---------------------------------------------------------------------------
// slots + explicit version upgrade
// ---------------------------------------------------------------------------

/**
 * §5.2 — a human edit sets `edited: true`, and regeneration skips such a slot
 * by default. The flag is set HERE, by the act of editing, rather than being
 * an input: a client that could send `edited: false` alongside its own prose
 * could arrange for the next regeneration to eat it.
 *
 * AND THE EDIT CLEARS EVERY FLAG ON THE SLOT (#10). A numeral violation
 * (§12.12c) and a refuted claim (§12.13) are both findings about PROSE, and
 * this prose is now different prose — carrying them forward would block the
 * publication of text nobody has actually judged. It is also the only exit
 * from a refutation, since the verifier never rewrites: without it, one
 * `refutado` wedges a report shut permanently. The numeral guard is
 * recomputed at publish either way, so nothing is weakened by dropping the
 * advisory copy.
 */
export async function updateSlot(
  dbHandle: DbLike,
  ctx: ReportCtx,
  input: UpdateSlotInputT,
): Promise<{ ok: true }> {
  const bundle = await loadReportBundle(dbHandle, ctx.tenantId, input.reportId);
  assertDraft(bundle.report);
  if (!bundle.slots.some((s) => s.slug === input.slug)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `O slot "${input.slug}" não existe nesta versão do modelo.`,
    });
  }
  const next = withSlot(bundle.content, input.slug, { text: input.text, edited: true });
  await dbHandle
    .update(reports)
    .set(withSystemFields({ userId: ctx.userId }, "update", { contentJson: next }))
    .where(and(eq(reports.id, input.reportId), eq(reports.tenantId, ctx.tenantId)));
  return { ok: true };
}

/**
 * §5.3 — "updating a draft to a newer version is explicit, never automatic".
 *
 * `content_json` is carried across UNCHANGED, including slots the new version
 * no longer declares. Deleting them here would be the §5.2 bug arriving
 * through the front door; leaving them costs a few bytes of jsonb and means a
 * mistaken upgrade is reversible by upgrading back.
 */
export async function upgradeReportVersion(
  dbHandle: DbLike,
  ctx: ReportCtx,
  input: { readonly reportId: string; readonly templateVersionId: string },
): Promise<{ ok: true }> {
  const report = await loadOwnedReport(dbHandle, ctx.tenantId, input.reportId);
  assertDraft(report);
  await assertVersionVisible(dbHandle, input.templateVersionId, ctx.tenantId);
  await dbHandle
    .update(reports)
    .set(
      withSystemFields({ userId: ctx.userId }, "update", {
        templateVersionId: input.templateVersionId,
      }),
    )
    .where(and(eq(reports.id, input.reportId), eq(reports.tenantId, ctx.tenantId)));
  return { ok: true };
}
