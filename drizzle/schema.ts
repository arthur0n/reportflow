// drizzle/schema.ts
//
// Full MVP schema. Tables:
//   1. tenants                  — our system-of-record for orgs (auth provider is an adapter)
//   2. users                    — authorization. Role lives here, not in auth provider.
//   3. list_of_values           — shared dictionary; rows are either system
//                                  (tenant_id IS NULL) or tenant-scoped. Types:
//                                  DRE_GROUP, TRANSACTION_TYPE, TRANSACTION_STATUS,
//                                  TRANSACTION_SUBTYPE_BR, STATEMENT_IMPORT_FILE_STATUS,
//                                  STATEMENT_IMPORT_ROW_STATUS, BANK_SLUG, CASH_BOX_TYPE,
//                                  PAYMENT_METHOD, TENANT_VALUES, CATEGORY. The
//                                  optional `category` column sub-scopes system
//                                  rows to an audience (e.g. category='restaurant'
//                                  on system CATEGORY rows); tenant rows leave it NULL.
//   4. tenant_values            — per-tenant lookup-style records; `kind` is the
//                                  discriminator and matches a list_of_values row
//                                  of type='TENANT_VALUES' (kinds: SUPPLIER, CUSTOMER,
//                                  CASH_BOX, BUSINESS_UNIT). Same narrow shape as list_of_values.
//   5. statement_imports        — uploaded bank statement files + status machine
//   6. transactions             — core fact table.
//                                  creditor_id, cash_box_id, business_unit_id → tenant_values.id.
//                                  category_id, payment_method_id → list_of_values.id.
//                                  transaction_type is a closed code matched
//                                  at runtime against TRANSACTION_TYPE_ATTRS
//                                  in shared/constants/transaction-types.ts.
//   7. statement_import_rows    — parsed rows from statement imports
//   8. statement_import_events  — log for import status transitions
//   9. questions_and_feedback   — dev-tooling QA / feedback
//  10. audit_logs               — generic field-level audit trail (tenant-scoped)
//
// tenant_id is always uuid — FK to tenants.id. Our system owns tenant identity;
// the auth provider is an adapter. External provider IDs stored on
// tenants/users as external_id.
//
// Convention: every new table MUST also get a TABLE_SCOPE entry in
// api/db/scope.ts — that's how multi-tenant + soft-delete stay enforced.

/* eslint-disable max-lines */
import { sql } from "drizzle-orm";
import {
  pgTable,
  index,
  uuid,
  text,
  varchar,
  integer,
  smallint,
  bigint,
  date,
  timestamp,
  uniqueIndex,
  check,
  jsonb,
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
    // UI surface gate: 'import_only' collapses navigation to the imports +
    // conciliation flow until the tenant opts into the full app.
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
// 11. statement_imports — uploaded bank statement files + status machine
// ---------------------------------------------------------------------------

export const statementImports = pgTable(
  "statement_imports",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    uploadBatchId: uuid("upload_batch_id"),
    // FK → tenant_values.id where kind='CASH_BOX'.
    cashBoxId: uuid("cash_box_id").references(() => tenantValues.id),
    fileName: text("file_name").notNull(),
    fileSize: integer("file_size").notNull(),
    fileHash: text("file_hash").notNull(),
    s3Key: text("s3_key"),
    sourceFormat: text("source_format"),
    // Semantic side of the file: 'bank' statements promote to transactions,
    // 'card' acquirer reports promote to acquirer_sales. Set from the
    // parser's kind — kept apart from source_format so a future bank CSV
    // stays 'bank'.
    sourceKind: text("source_kind").notNull().default("bank"),
    // FK → list_of_values type='ACQUIRER'; set at parse from parser.acquirer.
    acquirerId: uuid("acquirer_id").references(() => listOfValues.id),
    // Merchant CPF/CNPJ from an acquirer report's header. Self-referenced pix
    // deposits (the QR sales) carry it in their bank description — the
    // pix_day_sum rule keys on it.
    merchantTaxId: varchar("merchant_tax_id", { length: 18 }),
    bankSlug: text("bank_slug"),
    accountRef: text("account_ref"),
    periodStart: date("period_start"),
    periodEnd: date("period_end"),
    status: text().notNull().default("uploaded_pending"),
    rowsTotal: integer("rows_total").notNull().default(0),
    rowsError: integer("rows_error").notNull().default(0),
    // Bank rows whose external_id (OFX FITID) already exists in another live
    // import — overlapping/renamed re-exports; skipped, never double-counted.
    rowsDuplicate: integer("rows_duplicate").notNull().default(0),
    errorMessage: text("error_message"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    parsedAt: timestamp("parsed_at", { withTimezone: true, mode: "string" }),
    approvedAt: timestamp("approved_at", { withTimezone: true, mode: "string" }),
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
    uniqueIndex("statement_imports_tenant_file_hash_idx")
      .on(t.tenantId, t.fileHash)
      .where(sql`${t.status} NOT IN ('approved', 'rejected', 'upload_timeout')`),
    index("statement_imports_tenant_status_updated_idx").on(t.tenantId, t.status, t.lastUpdAt),
    check("statement_imports_source_kind_check", sql`${t.sourceKind} IN ('bank', 'card')`),
  ],
);

// TRANSACTION_TYPE catalog lives entirely in list_of_values
// (tenant_id IS NULL, type='TRANSACTION_TYPE'). The seven labels are seeded
// by scripts/seed.ts. The product-fixed flags (affects_dre, requires_creditor,
// requires_category) live in shared/constants/transaction-types.ts as a
// TypeScript const — they are invariants, not values.

// ---------------------------------------------------------------------------
// 13a. transaction_recurrences — series template for recurring transactions
// ---------------------------------------------------------------------------
// One row per series the user chose to repeat. Every transaction in the
// series (the source plus generated forecast siblings) carries the same
// recurrence_id. Cadence is delegated to a system RECURRENCE_PATTERN LOV row
// — `recurrence_pattern_id` points at it, and that row's `description`
// carries the iCalendar RRULE string the engine parses (no homegrown date
// math). v1 still generates eagerly: `mode='finite'` → exactly `repeat_count`
// siblings; `mode='always'` → every occurrence within 24 months of
// `start_date`. RECURRENCE_PATTERN is system-only (no tenant rows, ever).

export const transactionRecurrences = pgTable(
  "transaction_recurrences",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // 'finite' | 'always'. App-enforced via the check below.
    mode: varchar({ length: 16 }).notNull(),
    // Required when mode='finite'; NULL when mode='always'.
    repeatCount: integer("repeat_count"),
    // FK → list_of_values.id where type='RECURRENCE_PATTERN' (system row).
    // The row's `description` column carries the iCalendar RRULE string fed
    // to the rrule library (api/services/recurrence-generate.ts).
    recurrencePatternId: uuid("recurrence_pattern_id")
      .notNull()
      .references(() => listOfValues.id),
    // Anchor date for the first occurrence (= source transaction's accrual_date).
    startDate: date("start_date").notNull(),
    // Last occurrence date that has been materialized as a transaction. Lets
    // a future "extend" job pick up where we left off without re-deriving.
    generatedUntil: date("generated_until").notNull(),
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
    index("transaction_recurrences_tenant_idx")
      .on(t.tenantId)
      .where(sql`${t.deletedAt} IS NULL`),
    check("transaction_recurrences_mode_check", sql`${t.mode} IN ('finite','always')`),
    check(
      "transaction_recurrences_finite_has_count_check",
      sql`${t.mode} <> 'finite' OR ${t.repeatCount} IS NOT NULL`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 13. transactions — core fact table
// ---------------------------------------------------------------------------

export const transactions = pgTable(
  "transactions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    businessUnitId: uuid("business_unit_id").references(() => tenantValues.id),
    // FK → list_of_values.id where type='TRANSACTION_TYPE' (system row).
    transactionTypeId: uuid("transaction_type_id")
      .notNull()
      .references(() => listOfValues.id),
    // FK → tenant_values.id where kind IN ('SUPPLIER', 'CUSTOMER').
    creditorId: uuid("creditor_id").references(() => tenantValues.id),
    // FK → list_of_values.id where type='CATEGORY' (tenant-scoped LOV row).
    categoryId: uuid("category_id").references(() => listOfValues.id),
    // FK → list_of_values.id where type='PAYMENT_METHOD' (system).
    paymentMethodId: uuid("payment_method_id").references(() => listOfValues.id),
    // FK → list_of_values.id where type='TRANSACTION_SUBTYPE' (system or tenant).
    subtypeId: uuid("subtype_id").references(() => listOfValues.id),
    // FK → tenant_values.id where kind='CASH_BOX'.
    cashBoxId: uuid("cash_box_id").references(() => tenantValues.id),
    // FK → transaction_recurrences.id. Set on both the source transaction and
    // every generated forecast sibling; NULL for standalone transactions.
    recurrenceId: uuid("recurrence_id").references(() => transactionRecurrences.id),
    statementImportId: uuid("statement_import_id").references(() => statementImports.id),
    accrualDate: date("accrual_date").notNull(),
    dueDate: date("due_date").notNull(),
    actualDate: date("actual_date"),
    forecastAmount: bigint("forecast_amount", { mode: "bigint" }).notNull(),
    actualAmount: bigint("actual_amount", { mode: "bigint" }),
    interestAmount: bigint("interest_amount", { mode: "bigint" })
      .notNull()
      .generatedAlwaysAs(sql`COALESCE(actual_amount, 0::bigint) - forecast_amount`),
    // FK → list_of_values.id where type='TRANSACTION_STATUS' (system row).
    // INATIVO is encoded by deleted_at, not by a status row.
    statusId: uuid("status_id")
      .notNull()
      .references(() => listOfValues.id),
    description: text(),
    // Free-text identifier — NF number, boleto, competência string. Searchable.
    reference: varchar({ length: 80 }),
    externalId: varchar("external_id", { length: 100 }),
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
    // Primary DRE query pattern
    index("transactions_tenant_bu_accrual_idx").on(t.tenantId, t.businessUnitId, t.accrualDate),
    // "Due this week" view
    index("transactions_tenant_bu_due_idx").on(t.tenantId, t.businessUnitId, t.dueDate),
    // Creditor history
    index("transactions_tenant_creditor_idx").on(t.tenantId, t.creditorId),
    // Status filter (partial — only non-deleted)
    index("transactions_tenant_status_idx")
      .on(t.tenantId, t.statusId)
      .where(sql`${t.deletedAt} IS NULL`),
    // Monthly DRE rollup refresh
    index("transactions_tenant_accrual_category_idx").on(t.tenantId, t.accrualDate, t.categoryId),
    // Import traceability — safety rail for stable external IDs
    uniqueIndex("transactions_tenant_external_id_idx")
      .on(t.tenantId, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
    // CHECK constraints
    check("transactions_due_after_accrual_check", sql`${t.dueDate} >= ${t.accrualDate}`),
    check("transactions_forecast_nonzero_check", sql`${t.forecastAmount} != 0`),
    check(
      "transactions_actual_sign_check",
      sql`${t.actualAmount} IS NULL OR (${t.actualAmount} > 0) = (${t.forecastAmount} > 0)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 14. statement_import_rows — parsed rows from statement imports
// ---------------------------------------------------------------------------

export const statementImportRows = pgTable(
  "statement_import_rows",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    statementImportId: uuid("statement_import_id")
      .notNull()
      .references(() => statementImports.id),
    lineNumber: integer("line_number").notNull(),
    status: text().notNull(),
    rawPayload: jsonb("raw_payload"),
    actualDate: date("actual_date"),
    // Accrual date (PT-BR "competência") — defaults to actual_date at parse time,
    // editable during review, written to transactions.accrual_date on approve.
    accrualDate: date("accrual_date"),
    actualAmount: bigint("actual_amount", { mode: "bigint" }),
    description: text(),
    // FK → list_of_values.id where type='TRANSACTION_SUBTYPE'. Fiscal /
    // operational tag (TARIFA, IOF, RENDIMENTO, ...). Orthogonal to
    // payment_method_id and category_id.
    subtypeId: uuid("subtype_id").references(() => listOfValues.id),
    // FK → list_of_values.id where type='CATEGORY' (tenant-scoped LOV row).
    categoryId: uuid("category_id").references(() => listOfValues.id),
    // FK → tenant_values.id where kind IN ('SUPPLIER', 'CUSTOMER').
    creditorId: uuid("creditor_id").references(() => tenantValues.id),
    // FK → list_of_values.id where type='PAYMENT_METHOD' (system).
    paymentMethodId: uuid("payment_method_id").references(() => listOfValues.id),
    // FK → tenant_values.id where kind='BUSINESS_UNIT' (Centro de custo).
    businessUnitId: uuid("business_unit_id").references(() => tenantValues.id),
    // Free-text identifier — NF number, boleto, competência string. Mirrors
    // transactions.reference; pre-populated from OFX CHECKNUM/REFNUM at parse time.
    reference: varchar({ length: 80 }),
    externalId: text("external_id"),
    matchedTransactionId: uuid("matched_transaction_id").references(() => transactions.id),
    matchConfidence: smallint("match_confidence"),
    // Strategy id of the chain's winning auto-pick at parse time. NULL when nothing
    // crossed AUTO_APPLY_THRESHOLD. Values: 'exact-code' | 'rule:<id>' | 'learned' | 'trigram' | 'ai'.
    // Length 64 fits 'rule:<uuid>' (41 chars) with headroom for future prefixed strategies.
    sourceStrategy: varchar("source_strategy", { length: 64 }),
    // Full chain trace per target — { 'lov:CATEGORY': MatchOutcome, 'tv:SUPPLIER': MatchOutcome, ... }.
    // Read at review time so we can record both the new pick and the displaced one.
    matchProposalJson: jsonb("match_proposal_json"),
    errorDetail: text("error_detail"),
    editedAt: timestamp("edited_at", { withTimezone: true, mode: "string" }),
    editedBy: uuid("edited_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: "string" }),
    reviewedBy: uuid("reviewed_by"),
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
    index("statement_import_rows_import_line_idx").on(t.statementImportId, t.lineNumber),
    index("statement_import_rows_matched_txn_idx").on(t.matchedTransactionId),
  ],
);

// ---------------------------------------------------------------------------
// 15. statement_import_events — audit log for import status transitions
// ---------------------------------------------------------------------------

export const statementImportEvents = pgTable(
  "statement_import_events",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    statementImportId: uuid("statement_import_id")
      .notNull()
      .references(() => statementImports.id),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    actorUserId: uuid("actor_user_id"),
    reason: text(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    createdBy: uuid("created_by"),
    lastUpdAt: timestamp("last_upd_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    lastUpdBy: uuid("last_upd_by"),
  },
  (t) => [index("statement_import_events_import_idx").on(t.statementImportId)],
);

// ---------------------------------------------------------------------------
// 15a. acquirer_sales — G-02 conciliation ledger
//
// One row per INDIVIDUAL SALE from an acquirer's detailed report ("Detalhado
// de vendas"). expected_payment_date is the acquirer's own settlement
// declaration and the matching key; sale_code dedups re-imports and lets the
// user find the sale in the acquirer portal. Soft-delete = user "ignored"
// the row. See G-02 tech plan.
// ---------------------------------------------------------------------------

export const acquirerSales = pgTable(
  "acquirer_sales",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    // FK → list_of_values row of type='ACQUIRER' (system-seeded registry).
    acquirerId: uuid("acquirer_id")
      .notNull()
      .references(() => listOfValues.id),
    statementImportId: uuid("statement_import_id")
      .notNull()
      .references(() => statementImports.id),
    saleDate: date("sale_date").notNull(),
    // "Estabelecimento" — scopes sale_code dedup: Cielo sale codes are only
    // unique within one merchant account, and a tenant may import several.
    merchantAccount: text("merchant_account").notNull(),
    // "Hora da venda" (HH:mm) — lets the user locate the sale on the POS day.
    saleTime: text("sale_time"),
    // Acquirer's raw payment-method label ("Crédito à vista"). Read by the
    // issues report; PAYMENT_METHOD mapping is a tracked follow-up.
    method: text().notNull(),
    // "Bandeira" (Visa/Mastercard/Elo/Pix) — keys brand-split payouts.
    brand: text(),
    grossAmount: bigint("gross_amount", { mode: "bigint" }).notNull(),
    feeAmount: bigint("fee_amount", { mode: "bigint" }).notNull(),
    netAmount: bigint("net_amount", { mode: "bigint" }).notNull(),
    // "Data prevista do pagamento" — the acquirer's declared settlement date;
    // batches are matched on it, and overdue = today past it while unmatched.
    expectedPaymentDate: date("expected_payment_date").notNull(),
    // "NSU/DOC" and "Código da venda" — portal lookup; sale_code dedups.
    nsu: text(),
    saleCode: text("sale_code").notNull(),
    // Pix end-to-end id (TxID) when the sale is pix.
    txId: text("tx_id"),
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
    uniqueIndex("acquirer_sales_sale_code_idx")
      .on(t.tenantId, t.acquirerId, t.merchantAccount, t.saleCode)
      .where(sql`${t.deletedAt} IS NULL`),
    index("acquirer_sales_date_idx").on(t.tenantId, t.saleDate),
    index("acquirer_sales_prevista_idx").on(t.tenantId, t.expectedPaymentDate),
  ],
);

// ---------------------------------------------------------------------------
// 15b. acquirer_sale_settlements — G-02 match links (M:N)
//
// One row per (sale row, statement row) pair the matcher or the user linked.
// M:N because settlement shapes go both ways: a D+1 batch deposit covers a
// whole day's sales (N:1), while a day's pix sales arrive as one bank credit
// per sale (1:N). A sale is "conciliada" iff it has at least one link. Links
// are hard-deleted on unmatch — audit_logs carries the history.
// ---------------------------------------------------------------------------

export const acquirerSaleSettlements = pgTable(
  "acquirer_sale_settlements",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    saleId: uuid("sale_id")
      .notNull()
      .references(() => acquirerSales.id),
    statementRowId: uuid("statement_row_id")
      .notNull()
      .references(() => statementImportRows.id),
    // Rule that created the link: exact_value | day_sum | pix_day_sum | manual.
    rule: varchar({ length: 32 }).notNull(),
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
    uniqueIndex("acquirer_sale_settlements_pair_idx").on(t.saleId, t.statementRowId),
    index("acquirer_sale_settlements_row_idx").on(t.tenantId, t.statementRowId),
    index("acquirer_sale_settlements_sale_idx").on(t.tenantId, t.saleId),
  ],
);

// ---------------------------------------------------------------------------
// 16. questions_and_feedback — DEV TOOLING (temporary, remove post-MVP)
//
// Shared across all signed-in users (no tenant_id). Tracks AI questions for
// the PO/SE plus bugs/feedback the team files during MVP development.
// Replaced by a real tracker (Linear / GitHub Issues) once the product ships.
// ---------------------------------------------------------------------------

export const questionsAndFeedback = pgTable(
  "questions_and_feedback",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    ref: integer().notNull().generatedByDefaultAsIdentity(),
    kind: varchar({ length: 20 }).notNull(),
    feature: varchar({ length: 50 }),
    title: text().notNull(),
    body: text().notNull(),
    owner: varchar({ length: 20 }).notNull(),
    author: varchar({ length: 20 }).notNull(),
    status: varchar({ length: 20 }).notNull().default("open"),
    answer: text(),
    answeredBy: varchar("answered_by", { length: 20 }),
    answeredAt: timestamp("answered_at", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "string" }),
  },
  (t) => [
    uniqueIndex("qf_ref_idx").on(t.ref),
    index("qf_status_idx")
      .on(t.status)
      .where(sql`${t.deletedAt} IS NULL`),
    index("qf_owner_idx")
      .on(t.owner)
      .where(sql`${t.deletedAt} IS NULL`),
    index("qf_kind_idx")
      .on(t.kind)
      .where(sql`${t.deletedAt} IS NULL`),
    index("qf_feature_idx")
      .on(t.feature)
      .where(sql`${t.deletedAt} IS NULL AND ${t.feature} IS NOT NULL`),
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
        'match', 'unmatch',
        'TENANT_SWITCH', 'MEMBERSHIP_INVITE', 'MEMBERSHIP_ACCEPT',
        'MEMBERSHIP_REVOKE', 'MEMBERSHIP_ROLE_CHANGE'
      )`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 17. import_match_decisions — append-only learning log.
//     One row per classifier decision the user makes during import review.
//     Powers LearnedDecisionMatcher via a windowed aggregate keyed by
//     (tenant_id, target_kind, input_normalized).
//     Append-only: no soft-delete, no updates after insert.
// ---------------------------------------------------------------------------

export const importMatchDecisions = pgTable(
  "import_match_decisions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    statementImportRowId: uuid("statement_import_row_id").references(() => statementImportRows.id),
    // 'CATEGORY' | 'PAYMENT_METHOD' | 'SUPPLIER' | 'CUSTOMER'
    targetKind: varchar("target_kind", { length: 30 }).notNull(),
    // Exactly one set, matching targetKind. Enforced by the check below.
    lovTargetId: uuid("lov_target_id").references(() => listOfValues.id),
    tvTargetId: uuid("tv_target_id").references(() => tenantValues.id),
    inputRaw: text("input_raw").notNull(),
    inputNormalized: text("input_normalized").notNull(),
    proposedByStrategy: varchar("proposed_by_strategy", { length: 64 }),
    proposedConfidence: smallint("proposed_confidence"),
    // 'accepted' | 'overridden' | 'manual'
    decisionKind: varchar("decision_kind", { length: 20 }).notNull(),
    overriddenLovTargetId: uuid("overridden_lov_target_id").references(() => listOfValues.id),
    overriddenTvTargetId: uuid("overridden_tv_target_id").references(() => tenantValues.id),
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
    index("import_match_decisions_lookup_idx").on(t.tenantId, t.targetKind, t.inputNormalized),
    index("import_match_decisions_strategy_idx").on(
      t.tenantId,
      t.proposedByStrategy,
      t.decisionKind,
    ),
    index("import_match_decisions_row_idx").on(t.statementImportRowId),
    check(
      "import_match_decisions_target_xor_check",
      sql`(${t.lovTargetId} IS NOT NULL AND ${t.tvTargetId} IS NULL) OR (${t.lovTargetId} IS NULL AND ${t.tvTargetId} IS NOT NULL)`,
    ),
    check(
      "import_match_decisions_decision_kind_check",
      sql`${t.decisionKind} IN ('accepted', 'overridden', 'manual')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 18. import_match_rules — patterns consumed by RuleMatcher.
//     tenant_id IS NULL = system rule (vendored, applies to everyone),
//     tenant_id = X      = tenant-scoped rule (admin-authored or user-promoted).
//     Mirrors list_of_values' system/tenant duality. RuleMatcher loads both
//     pools and lets tenant rules win ties.
//     System rules MUST target list_of_values rows (tenant_values are
//     per-tenant, not shareable across tenants).
// ---------------------------------------------------------------------------

export const importMatchRules = pgTable(
  "import_match_rules",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    // NULL = system rule. Set = tenant rule.
    tenantId: uuid("tenant_id").references(() => tenants.id),
    // Mirrors list_of_values.category — only meaningful on system rules.
    // NULL on tenant rules; NULL on a system rule = applies to every audience.
    category: varchar({ length: 50 }),
    // 'CATEGORY' | 'PAYMENT_METHOD' | 'SUPPLIER' | 'CUSTOMER'
    targetKind: varchar("target_kind", { length: 30 }).notNull(),
    // 'regex' | 'contains' | 'equals'
    matchKind: varchar("match_kind", { length: 20 }).notNull(),
    pattern: text().notNull(),
    lovTargetId: uuid("lov_target_id").references(() => listOfValues.id),
    tvTargetId: uuid("tv_target_id").references(() => tenantValues.id),
    confidence: smallint().notNull().default(85),
    priority: integer().notNull().default(100),
    // 'system_seed' | 'admin' | 'user_promoted'
    origin: varchar({ length: 20 }).notNull(),
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
    index("import_match_rules_tenant_idx")
      .on(t.tenantId, t.targetKind, t.priority)
      .where(sql`${t.deletedAt} IS NULL AND ${t.tenantId} IS NOT NULL`),
    index("import_match_rules_system_idx")
      .on(t.targetKind, t.priority)
      .where(sql`${t.deletedAt} IS NULL AND ${t.tenantId} IS NULL`),
    check(
      "import_match_rules_target_xor_check",
      sql`(${t.lovTargetId} IS NOT NULL AND ${t.tvTargetId} IS NULL) OR (${t.lovTargetId} IS NULL AND ${t.tvTargetId} IS NOT NULL)`,
    ),
    check(
      "import_match_rules_match_kind_check",
      sql`${t.matchKind} IN ('regex', 'contains', 'equals')`,
    ),
    check(
      "import_match_rules_origin_check",
      sql`${t.origin} IN ('system_seed', 'admin', 'user_promoted')`,
    ),
    // System rules cannot target tenant_values (those are per-tenant).
    check(
      "import_match_rules_system_lov_only_check",
      sql`${t.tenantId} IS NOT NULL OR ${t.tvTargetId} IS NULL`,
    ),
    // Tenant rules cannot use the audience `category` (only system rows do).
    check(
      "import_match_rules_tenant_no_category_check",
      sql`${t.tenantId} IS NULL OR ${t.category} IS NULL`,
    ),
  ],
);
