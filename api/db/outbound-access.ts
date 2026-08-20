// api/db/outbound-access.ts
//
// Dedicated scoped accessor for outbound_templates + outbound_template_versions
// (decisions §3.2/§5.3). Neither table fits the generic ScopedDb CRUD verbs:
//
//   - outbound_templates is registered `lov` in TABLE_SCOPE — `tenant_id IS
//     NULL` means a SYSTEM template visible to every org, not a tenant leak.
//     Reads go through lovConditions(outboundTemplates, mode).
//   - outbound_template_versions has NO tenant_id column at all. It is
//     reached ONLY by joining outbound_template_id back to its parent
//     outbound_templates row — see drizzle/tables/outbound.ts for why a
//     denormalised tenant_id was rejected.
//
// `assertVersionVisible` is the write-side guard: reports.create/update MUST
// call it before pinning `template_version_id`, since the version row itself
// carries no scoping information to check against — visibility can only be
// determined by looking at its parent template.

import { and, desc, eq } from "drizzle-orm";
import type { db } from "./client";
import { outboundTemplates, outboundTemplateVersions } from "../../drizzle/schema";
import { createScopedDb, withSystemFields } from "./scope";
import type { Tx } from "./scoped-client";

/** Anything that exposes select — either the pool or a tx. */
export type DbLike = typeof db | Tx;

export type LovScopeMode = "system" | "tenant" | "combined";

export type OutboundTemplateRow = typeof outboundTemplates.$inferSelect;
export type OutboundTemplateVersionRow = typeof outboundTemplateVersions.$inferSelect;

/**
 * List outbound templates visible to this tenant: own rows + system rows
 * (mode defaults to 'combined'), not-deleted.
 */
export async function listOutboundTemplates(
  dbHandle: DbLike,
  tenantId: string,
  options: { mode?: LovScopeMode } = {},
): Promise<OutboundTemplateRow[]> {
  const scope = createScopedDb({ tenantId });
  const conditions = scope.lovConditions(outboundTemplates, options.mode ?? "combined");
  return dbHandle.select().from(outboundTemplates).where(conditions);
}

/**
 * Fetch one outbound template by id, only if visible to this tenant (its own
 * row, or a system row), not-deleted.
 */
export async function getOutboundTemplate(
  dbHandle: DbLike,
  tenantId: string,
  id: string,
): Promise<OutboundTemplateRow | undefined> {
  const scope = createScopedDb({ tenantId });
  const conditions = scope.lovConditions(outboundTemplates, "combined");
  const [row] = await dbHandle
    .select()
    .from(outboundTemplates)
    .where(and(eq(outboundTemplates.id, id), conditions))
    .limit(1);
  return row;
}

/**
 * List every version of a template, reached ONLY through the parent
 * template's own visibility — outbound_template_versions has no tenant_id
 * of its own to filter on.
 */
export async function listOutboundTemplateVersions(
  dbHandle: DbLike,
  tenantId: string,
  templateId: string,
): Promise<OutboundTemplateVersionRow[]> {
  const scope = createScopedDb({ tenantId });
  const templateVisible = scope.lovConditions(outboundTemplates, "combined");
  const rows = await dbHandle
    .select({ version: outboundTemplateVersions })
    .from(outboundTemplateVersions)
    .innerJoin(
      outboundTemplates,
      eq(outboundTemplateVersions.outboundTemplateId, outboundTemplates.id),
    )
    .where(and(eq(outboundTemplateVersions.outboundTemplateId, templateId), templateVisible));
  return rows.map((r) => r.version);
}

/**
 * Fetch one template version by id, reached ONLY through the parent
 * template's visibility (own tenant or system), not-deleted template.
 */
export async function getOutboundTemplateVersion(
  dbHandle: DbLike,
  tenantId: string,
  templateVersionId: string,
): Promise<OutboundTemplateVersionRow | undefined> {
  const scope = createScopedDb({ tenantId });
  const templateVisible = scope.lovConditions(outboundTemplates, "combined");
  const [row] = await dbHandle
    .select({ version: outboundTemplateVersions })
    .from(outboundTemplateVersions)
    .innerJoin(
      outboundTemplates,
      eq(outboundTemplateVersions.outboundTemplateId, outboundTemplates.id),
    )
    .where(and(eq(outboundTemplateVersions.id, templateVersionId), templateVisible))
    .limit(1);
  return row?.version;
}

/**
 * Write-side guard. reports.create/update MUST call this before pinning
 * `template_version_id` to a version — the version row carries no tenant_id
 * of its own, so this is the ONLY thing standing between "pin any version by
 * id" and a cross-tenant read of another org's private template content.
 *
 * Verifies the version's parent template is either a SYSTEM template
 * (tenant_id IS NULL) or belongs to `tenantId`. Throws when the version
 * doesn't exist, or when its parent template belongs to a different tenant —
 * never silently allows pinning a version the caller cannot see.
 */
export async function assertVersionVisible(
  dbHandle: DbLike,
  templateVersionId: string,
  tenantId: string,
): Promise<void> {
  const [row] = await dbHandle
    .select({ templateTenantId: outboundTemplates.tenantId })
    .from(outboundTemplateVersions)
    .innerJoin(
      outboundTemplates,
      eq(outboundTemplateVersions.outboundTemplateId, outboundTemplates.id),
    )
    .where(eq(outboundTemplateVersions.id, templateVersionId))
    .limit(1);

  if (row === undefined) {
    throw new Error(
      `assertVersionVisible: outbound_template_versions "${templateVersionId}" does not exist`,
    );
  }

  const visible = row.templateTenantId === null || row.templateTenantId === tenantId;
  if (!visible) {
    throw new Error(
      `assertVersionVisible: outbound_template_versions "${templateVersionId}" belongs to a ` +
        `template outside tenant "${tenantId}" — refusing to pin it.`,
    );
  }
}

// ---------------------------------------------------------------------------
// WRITES.
//
// They live here for the same reason the reads do: this file's header claims
// to be the SOLE sanctioned accessor for these two tables, and a claim with an
// exception is not a claim. Both tables are registered `lov`, so the scoped
// write helpers (`assertTenantScoped`) refuse them by design — the tenant
// column is written explicitly below instead, from the caller's own ctx.
//
// Nothing here UPDATEs `outbound_template_versions`. There is no update path
// anywhere in the codebase, and that is the §5.3 guarantee: `content_json`
// references slot slugs, so editing a live version could delete a slot out
// from under a draft that has human-written prose in it. The immutability is
// held by ABSENCE of a writer, not by a check something could forget to run.
// ---------------------------------------------------------------------------

export interface OutboundWriteCtx {
  readonly tenantId: string;
  readonly userId: string;
}

/** Creates a TENANT template. A system template (`tenant_id IS NULL`) is a
 * platform-admin artifact and is deliberately not creatable from here — there
 * is no tenant-facing procedure that should be able to mint one. */
export async function insertOutboundTemplate(
  dbHandle: DbLike,
  ctx: OutboundWriteCtx,
  values: { readonly name: string; readonly description: string | null },
): Promise<OutboundTemplateRow> {
  const rows = await dbHandle
    .insert(outboundTemplates)
    .values(
      withSystemFields({ userId: ctx.userId }, "create", {
        tenantId: ctx.tenantId,
        name: values.name,
        description: values.description,
      }),
    )
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("insertOutboundTemplate: outbound_templates insert returned no row");
  }
  return row;
}

/**
 * Writes version N+1 for a template the caller can already see.
 *
 * `nextVersion` is read INSIDE the caller's transaction and the write is
 * guarded by `outbound_template_versions_template_version_idx` — read-then-
 * insert is check-then-act, so two authors saving the same template in the
 * same second both read N and one of them hits the unique index. That is the
 * intended outcome: a duplicate version is refused by Postgres rather than
 * silently overwriting, and the loser retries with a fresh read.
 */
export async function insertTemplateVersion(
  dbHandle: DbLike,
  ctx: OutboundWriteCtx,
  values: {
    readonly outboundTemplateId: string;
    readonly html: string;
    readonly slotsJson: unknown;
    readonly inputsJson: unknown;
  },
): Promise<OutboundTemplateVersionRow> {
  const [latest] = await dbHandle
    .select({ version: outboundTemplateVersions.version })
    .from(outboundTemplateVersions)
    .where(eq(outboundTemplateVersions.outboundTemplateId, values.outboundTemplateId))
    .orderBy(desc(outboundTemplateVersions.version))
    .limit(1);

  const rows = await dbHandle
    .insert(outboundTemplateVersions)
    .values(
      withSystemFields({ userId: ctx.userId }, "create", {
        outboundTemplateId: values.outboundTemplateId,
        version: (latest?.version ?? 0) + 1,
        slotsJson: values.slotsJson,
        inputsJson: values.inputsJson,
        html: values.html,
      }),
    )
    .returning();
  const row = rows[0];
  if (row === undefined) {
    throw new Error("insertTemplateVersion: outbound_template_versions insert returned no row");
  }
  // Touch the parent so the list can order by "last edited" without joining
  // every version. The PARENT is mutable; the version is not.
  await dbHandle
    .update(outboundTemplates)
    .set({ lastUpdAt: new Date().toISOString(), lastUpdBy: ctx.userId })
    .where(eq(outboundTemplates.id, values.outboundTemplateId));
  return row;
}

export interface LatestVersion {
  readonly templateId: string;
  readonly versionId: string;
  readonly version: number;
}

/** The highest version of each VISIBLE template. Powers the template list and
 * the "v3" the report-creation screen pins.
 *
 * Ordered read + a fold, rather than DISTINCT ON: the visible set is a
 * tenant's own templates plus the system ones — tens of rows, not thousands —
 * and the fold is the same answer in code every reader of this file can check
 * without knowing Postgres's DISTINCT ON ordering rule. */
export async function listLatestVersions(
  dbHandle: DbLike,
  tenantId: string,
): Promise<LatestVersion[]> {
  const scope = createScopedDb({ tenantId });
  const templateVisible = scope.lovConditions(outboundTemplates, "combined");
  const rows = await dbHandle
    .select({
      templateId: outboundTemplateVersions.outboundTemplateId,
      versionId: outboundTemplateVersions.id,
      version: outboundTemplateVersions.version,
    })
    .from(outboundTemplateVersions)
    .innerJoin(
      outboundTemplates,
      eq(outboundTemplateVersions.outboundTemplateId, outboundTemplates.id),
    )
    .where(templateVisible)
    .orderBy(desc(outboundTemplateVersions.version));

  const latest = new Map<string, LatestVersion>();
  for (const row of rows) {
    const seen = latest.get(row.templateId);
    if (seen === undefined || row.version > seen.version) {
      latest.set(row.templateId, row);
    }
  }
  return [...latest.values()];
}
