// drizzle/tables/outbound.ts
//
// The OUTPUT axis (decisions §3.2, §5.3): the account's HTML-with-slots
// templates and their immutable versions. Registered `lov` in TABLE_SCOPE —
// `tenant_id IS NULL` means a system template authored by the platform admin.

import { sql } from "drizzle-orm";
import {
  pgTable,
  index,
  uuid,
  text,
  varchar,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { TENANT_ID_LENGTH } from "./common";

// ---------------------------------------------------------------------------
// 9. outbound_templates — the OUTPUT side, per account (§3.2).
//
// Registered as `lov` in TABLE_SCOPE (§8 table): `tenant_id IS NULL` means a
// SYSTEM template authored by the platform admin and visible to every org;
// non-null means the account's own. This is the one documented exception to
// "tenant_id NOT NULL on tenant tables" — same shape, and same reason, as the
// baseline `list_of_values`. `conditions()` throws for `lov` tables on purpose.
//
// Name uniqueness is TWO partial unique indexes, not one composite
// UNIQUE(tenant_id, name): a plain composite unique never collides two
// system rows against each other, because NULL <> NULL for b-tree uniqueness
// — every "system" template could silently share a name with another. One
// partial index scopes tenant rows by (tenant_id, name); the other scopes
// system rows (tenant_id IS NULL) by name alone. Together they close that
// hole on both sides.
// ---------------------------------------------------------------------------

export const outboundTemplates = pgTable(
  "outbound_templates",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    // NULL = system template (platform admin). Non-null = a Clerk org_id.
    tenantId: varchar("tenant_id", { length: TENANT_ID_LENGTH }),
    name: varchar({ length: 120 }).notNull(),
    description: text(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    createdBy: uuid("created_by"),
    lastUpdAt: timestamp("last_upd_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    lastUpdBy: uuid("last_upd_by"),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "string" }),
    deletedBy: uuid("deleted_by"),
  },
  (t) => [
    uniqueIndex("outbound_templates_tenant_name_idx")
      .on(t.tenantId, t.name)
      .where(sql`${t.tenantId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    uniqueIndex("outbound_templates_system_name_idx")
      .on(t.name)
      .where(sql`${t.tenantId} IS NULL AND ${t.deletedAt} IS NULL`),
    index("outbound_templates_tenant_idx").on(t.tenantId),
  ],
);

// ---------------------------------------------------------------------------
// 10. outbound_template_versions — IMMUTABLE (§5.3).
//
// Editing a template writes version N+1; existing reports keep pointing at N.
// `content_json.slots` references slot slugs, so removing a slot from a live
// template would silently destroy human-written prose flagged `edited` — the
// exact bug §5.2 exists to prevent. Cost of preventing it: this table.
//
// Nothing here is ever UPDATEd. `last_upd_*` exists only so the shared
// withSystemFields('create') stamp writes cleanly; there is no update path.
//
// Deliberately NO `tenant_id` column. A denormalised copy of the parent's
// tenant_id can silently disagree with it, and a MATCH SIMPLE composite FK
// cannot guard the NULL case (a system template has tenant_id IS NULL, so
// MATCH SIMPLE lets a mismatched child row through whenever either FK column
// is NULL). Versions are reached ONLY by joining outbound_template_id back to
// the parent outbound_templates row — api/db/outbound-access.ts is the sole
// sanctioned accessor (list/get templates, list/get versions via the parent
// join, and `assertVersionVisible` for the write-side pin check). It stays
// registered `lov` in TABLE_SCOPE alongside the parent, purely so
// conditions()/assertTenantScoped() keep throwing on any direct scoped
// access attempt — the throw is the protection either way.
// ---------------------------------------------------------------------------

export const outboundTemplateVersions = pgTable(
  "outbound_template_versions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    outboundTemplateId: uuid("outbound_template_id")
      .notNull()
      .references(() => outboundTemplates.id),
    version: integer().notNull(),
    // Handlebars source, strict mode, four constructs only (§3.2 / §12.4).
    html: text().notNull(),
    // SlotDeclaration[] — { slug, guideline, maxWords }.
    slotsJson: jsonb("slots_json")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // RoleDeclaration[] — { key, provider, documentType, cardinality, required }.
    inputsJson: jsonb("inputs_json")
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    createdBy: uuid("created_by"),
    lastUpdAt: timestamp("last_upd_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    lastUpdBy: uuid("last_upd_by"),
  },
  (t) => [
    uniqueIndex("outbound_template_versions_template_version_idx").on(
      t.outboundTemplateId,
      t.version,
    ),
    check("outbound_template_versions_version_check", sql`${t.version} >= 1`),
  ],
);
