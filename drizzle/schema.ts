// drizzle/schema.ts
//
// Baseline MVP schema (post-domain-prune, org-based tenancy). Tables:
//   1. users                    — authorization. Identity is (open_id, tenant_id);
//                                  `role` is the permanent authorization layer.
//   2. list_of_values           — shared dictionary; rows are either system
//                                  (tenant_id IS NULL) or tenant-scoped.
//   3. tenant_values            — per-tenant lookup-style records; `kind` is the
//                                  discriminator and matches a list_of_values row
//                                  of type='TENANT_VALUES'.
//   4. audit_logs               — generic field-level audit trail (tenant-scoped)
//
// Tenancy (project_conventions §6): `tenant_id === Clerk org_id`. A tenant is a
// Clerk organization, not a local row — there is no `tenants` table and no
// `memberships` table. `tenant_id` is therefore ALWAYS `varchar(64)` (an opaque
// string like `org_2abc…`), never `uuid`, and never a foreign key.
//
// Convention: every new table MUST also get a TABLE_SCOPE entry in
// api/db/scope.ts — `conditions()` throws on an unregistered table
// (decisions §12.9), so a forgotten entry is a dev-time crash, not a leak.

import { sql } from "drizzle-orm";
import {
  pgTable,
  index,
  uuid,
  text,
  varchar,
  integer,
  timestamp,
  uniqueIndex,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

/** Clerk org id column type. One definition, reused by every scoped table. */
const TENANT_ID_LENGTH = 64;

// ---------------------------------------------------------------------------
// 1. users — identity + authorization.
//
// `open_id` is the auth provider's user id (Clerk `user_2abc…`). Identity is
// the composite (open_id, tenant_id): the same Clerk user can belong to more
// than one org with a different role in each — no schema change when the
// second customer lands.
//
// Roles (decisions §2):
//   platform_admin — ReportFlow staff (Arthur). Never crosses a tenant
//                    boundary: admin surfaces touch only `global` / `lov`
//                    tables. There is no unscoped db handle.
//   admin          — the account's owner.
//   member         — everyone else in the account.
//
// Rows are created manually (project_conventions §7) — no row, no access.
// ---------------------------------------------------------------------------

export const users = pgTable(
  "users",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    openId: varchar("open_id", { length: 64 }).notNull(),
    tenantId: varchar("tenant_id", { length: TENANT_ID_LENGTH }).notNull(),
    email: varchar({ length: 320 }),
    name: text(),
    role: varchar({ length: 20 }).notNull().default("member"),
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
    uniqueIndex("users_open_id_tenant_id_idx").on(t.openId, t.tenantId),
    index("users_tenant_idx").on(t.tenantId),
    check("users_role_check", sql`${t.role} IN ('platform_admin', 'admin', 'member')`),
  ],
);

// ---------------------------------------------------------------------------
// 2. list_of_values — canonical lookup table (system + per-tenant rows)
// Type discriminator values are UPPER_SNAKE_CASE (e.g. TENANT_VALUES, BANK_SLUG).
// Always query through scope.lovConditions — never scope.conditions.
// ---------------------------------------------------------------------------

export const listOfValues = pgTable(
  "list_of_values",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    type: varchar({ length: 50 }).notNull(),
    code: varchar({ length: 50 }).notNull(),
    value: varchar({ length: 100 }).notNull(),
    description: text(),
    parentLov: uuid("parent_lov").references((): AnyPgColumn => listOfValues.id),
    // NULL = system row (visible to every org). Non-null = a Clerk org_id.
    tenantId: varchar("tenant_id", { length: TENANT_ID_LENGTH }),
    // Optional sub-namespace for system rows, so independent system seeds of
    // the same `type` don't overwrite each other. NULL on tenant rows.
    category: varchar({ length: 50 }),
    language: varchar({ length: 5 }).default("pt-BR"),
    sortOrder: integer("sort_order").default(0),
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
    uniqueIndex("lov_tenant_type_category_code_idx")
      .on(t.tenantId, t.type, t.category, t.code)
      .where(sql`${t.deletedAt} IS NULL`),
    index("lov_type_idx").on(t.type),
    index("lov_tenant_type_idx").on(t.tenantId, t.type),
    index("lov_type_category_idx").on(t.type, t.category),
    index("lov_parent_lov_idx").on(t.parentLov),
    index("lov_type_parent_idx").on(t.type, t.parentLov),
  ],
);

// ---------------------------------------------------------------------------
// 3. tenant_values — per-tenant lookup-style records.
// `kind` is a varchar discriminator (e.g. 'SUPPLIER', 'CUSTOMER', 'CASH_BOX',
// 'BUSINESS_UNIT') matching a list_of_values row of type='TENANT_VALUES'.
// ---------------------------------------------------------------------------

export const tenantValues = pgTable(
  "tenant_values",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: varchar("tenant_id", { length: TENANT_ID_LENGTH }).notNull(),
    kind: varchar({ length: 50 }).notNull(),
    code: varchar({ length: 50 }).notNull(),
    value: varchar({ length: 100 }).notNull(),
    description: text(),
    parentLov: uuid("parent_lov").references(() => listOfValues.id),
    // Required iff kind='CASH_BOX' AND parent_lov points to the 'bank'
    // CASH_BOX_TYPE row. NULL otherwise. App-enforced (router); FK target
    // must be a system list_of_values row of type='BANK_SLUG'.
    bankSlugId: uuid("bank_slug_id").references(() => listOfValues.id),
    language: varchar({ length: 5 }).default("pt-BR"),
    sortOrder: integer("sort_order").default(0),
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
    uniqueIndex("tenant_values_tenant_kind_code_idx")
      .on(t.tenantId, t.kind, t.code)
      .where(sql`${t.deletedAt} IS NULL`),
    index("tenant_values_tenant_kind_idx").on(t.tenantId, t.kind),
    index("tenant_values_parent_lov_idx").on(t.parentLov),
  ],
);

// ---------------------------------------------------------------------------
// 4. audit_logs — generic, tenant-scoped, append-only audit trail.
//     Field-level rows: one row per changed field on 'update'; one row per
//     action on 'create' | 'delete' | 'restore' | 'reclassify'.
//     entity_type aligns with list_of_values.type vocabulary (UPPER_SNAKE_CASE).
//     last_upd_* mirrors created_* per the uniform system-fields convention.
// ---------------------------------------------------------------------------

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: varchar("tenant_id", { length: TENANT_ID_LENGTH }).notNull(),
    entityType: varchar("entity_type", { length: 40 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    action: varchar({ length: 40 }).notNull(),
    fieldName: text("field_name"),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    createdBy: uuid("created_by").notNull(),
    lastUpdAt: timestamp("last_upd_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    lastUpdBy: uuid("last_upd_by").notNull(),
  },
  (t) => [
    index("audit_logs_entity_idx").on(t.tenantId, t.entityType, t.entityId, t.createdAt),
    index("audit_logs_tenant_created_idx").on(t.tenantId, t.createdAt),
    check(
      "audit_logs_action_check",
      sql`${t.action} IN (
        'create', 'update', 'delete', 'restore', 'reclassify', 'promote_to_system'
      )`,
    ),
  ],
);
