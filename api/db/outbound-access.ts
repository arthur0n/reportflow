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

import { and, eq } from "drizzle-orm";
import type { db } from "./client";
import { outboundTemplates, outboundTemplateVersions } from "../../drizzle/schema";
import { createScopedDb } from "./scope";
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
