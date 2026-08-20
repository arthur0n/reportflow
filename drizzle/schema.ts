// drizzle/schema.ts
//
// Baseline MVP schema (post-domain-prune). Tables:
//   1. tenants                  — our system-of-record for orgs (auth provider is an adapter)
//   2. users                    — authorization. Role lives here, not in auth provider.
//   2b. memberships             — per-tenant grants (see tenancy pass for the Clerk-org rewrite).
//   3. list_of_values           — shared dictionary; rows are either system
//                                  (tenant_id IS NULL) or tenant-scoped.
//   4. tenant_values            — per-tenant lookup-style records; `kind` is the
//                                  discriminator and matches a list_of_values row
//                                  of type='TENANT_VALUES' (kinds: SUPPLIER, CUSTOMER,
//                                  CASH_BOX, BUSINESS_UNIT).
//   5. audit_logs               — generic field-level audit trail (tenant-scoped)
//
// tenant_id is always uuid — FK to tenants.id. Our system owns tenant identity;
// the auth provider is an adapter. External provider IDs stored on
// tenants/users as external_id.
//
// Convention: every new table MUST also get a TABLE_SCOPE entry in
// api/db/scope.ts — that's how multi-tenant + soft-delete stay enforced.

import { sql } from "drizzle-orm";
import {
  pgTable,
  index,
  uuid,
  text,
  varchar,
  integer,
  smallint,
  timestamp,
  uniqueIndex,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// 1. tenants — system-of-record for orgs
// ---------------------------------------------------------------------------

export const tenants = pgTable(
  "tenants",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    externalId: varchar("external_id", { length: 64 }).notNull().unique(),
    name: text().notNull(),
    cnpj: varchar({ length: 18 }),
    industry: text().notNull().default("restaurant"),
    fiscalYearStart: smallint("fiscal_year_start").notNull().default(1),
    timezone: text().notNull().default("America/Sao_Paulo"),
    // Billing scaffold. Field-only — no Stripe yet. Mutated by manual SQL
    // until the billing UI lands. (plan, trial_ends_at) encodes lifecycle
    // without a separate subscription_status column.
    plan: varchar({ length: 32 }).notNull().default("friends_and_family"),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true, mode: "string" }),
    billingEmail: varchar("billing_email", { length: 320 }),
    // UI surface gate. 'import_only' is currently unused pending the
    // domain rebuild (see pass-a scaffold prune); kept as a schema field.
    mode: varchar({ length: 16 }).notNull().default("full"),
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
    uniqueIndex("tenants_cnpj_idx")
      .on(t.cnpj)
      .where(sql`${t.cnpj} IS NOT NULL`),
    check("tenants_plan_check", sql`${t.plan} IN ('friends_and_family', 'free', 'paid')`),
    check("tenants_mode_check", sql`${t.mode} IN ('full', 'import_only')`),
  ],
);

// ---------------------------------------------------------------------------
// 2. users — identity (tenant-independent). Per-tenant authority lives in
//    memberships. active_tenant_id is the user's currently-selected tenant
//    (Salesforce model); platform_role flags ReportFlow staff with
//    cross-tenant authority via adminDb.
// ---------------------------------------------------------------------------

export const users = pgTable(
  "users",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    externalId: varchar("external_id", { length: 64 }).notNull(),
    activeTenantId: uuid("active_tenant_id").references(() => tenants.id),
    email: varchar({ length: 320 }),
    name: text(),
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
    uniqueIndex("users_external_id_idx").on(t.externalId),
    index("users_active_tenant_idx").on(t.activeTenantId),
  ],
);

// ---------------------------------------------------------------------------
// 2b. memberships — per-tenant grants. Replaces users.tenant_id (dropped).
//     Lifecycle by joined_at + expires_at + deleted_at; no status column.
//       invited  → joined_at IS NULL    AND deleted_at IS NULL
//       active   → joined_at IS NOT NULL AND deleted_at IS NULL
//                  AND (expires_at IS NULL OR expires_at > now())
//       expired  → expires_at < now() (computed)
//       revoked  → deleted_at IS NOT NULL
//     Roles: 'owner' | 'admin' | 'member' | 'consultant_view'. F&F today
//     writes only 'owner'; the others are reserved for follow-up plans.
// ---------------------------------------------------------------------------

export const memberships = pgTable(
  "memberships",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // Numeric rank. 0 = reportflow, 1 = tenant admin (signup default).
    // 10 / 20 / etc. reserved for later. Display labels in LOV
    // type='MEMBERSHIP_ROLE'. Authority checks use `<=` against
    // MEMBERSHIP_RANK constants in shared/constants/membership-roles.ts.
    role: integer().notNull(),
    invitedBy: uuid("invited_by").references((): AnyPgColumn => users.id),
    invitedAt: timestamp("invited_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true, mode: "string" }),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }),
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
    uniqueIndex("memberships_user_tenant_unique")
      .on(t.userId, t.tenantId)
      .where(sql`${t.deletedAt} IS NULL`),
    index("memberships_user_idx").on(t.userId),
    index("memberships_tenant_idx").on(t.tenantId, t.deletedAt),
    check("memberships_role_check", sql`${t.role} >= 0`),
  ],
);

// ---------------------------------------------------------------------------
// 3. list_of_values — canonical lookup table (system + per-tenant rows)
// Type discriminator values are UPPER_SNAKE_CASE (e.g. DRE_GROUP, CATEGORY).
// Always query with both tenant_id and type filters via scope.lovConditions.
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
    tenantId: uuid("tenant_id"),
    // Sub-discriminator for system rows (e.g. 'restaurant' on system CATEGORY).
    // NULL on tenant rows — their audience is already tenant_id + tenants.industry.
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
// tenant_values — per-tenant lookup-style records.
// `kind` is a varchar discriminator (e.g. 'SUPPLIER', 'CUSTOMER', 'CASH_BOX',
// 'BUSINESS_UNIT') matching a list_of_values row of type='TENANT_VALUES'.
// Same narrow shape as list_of_values; per-type extras would require a
// separate sidecar table — none exist today.
// ---------------------------------------------------------------------------

export const tenantValues = pgTable(
  "tenant_values",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
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
// 16. audit_logs — generic, tenant-scoped, append-only audit trail.
//     Field-level rows: one row per changed field on 'update'; one row per
//     action on 'create' | 'delete' | 'restore' | 'reclassify'.
//     entity_type aligns with list_of_values.type vocabulary (UPPER_SNAKE_CASE).
//     last_upd_* mirrors created_* per the uniform system-fields convention.
// ---------------------------------------------------------------------------

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
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
        'create', 'update', 'delete', 'restore', 'reclassify', 'promote_to_system',
        'TENANT_SWITCH', 'MEMBERSHIP_INVITE', 'MEMBERSHIP_ACCEPT',
        'MEMBERSHIP_REVOKE', 'MEMBERSHIP_ROLE_CHANGE'
      )`,
    ),
  ],
);
