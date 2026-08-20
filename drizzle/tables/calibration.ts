// drizzle/tables/calibration.ts
//
// The INPUT axis (decisions §3.1): providers → document types → the frozen
// extract template (field list + input_mode + detect_hint) that Calibrate
// produces. N extract templates × M outbound templates; the two axes are
// independent and must not be conflated.

import { sql } from "drizzle-orm";
import {
  pgTable,
  index,
  uuid,
  text,
  varchar,
  integer,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { TENANT_ID_LENGTH } from "./common";

// ---------------------------------------------------------------------------
// 5. providers — who issued the document (Toysmith, House Living, …).
// A provider is NOT a document type: the same provider issues both a nota
// fiscal and a contrato, and they need different field lists (§3.1).
// ---------------------------------------------------------------------------

export const providers = pgTable(
  "providers",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: varchar("tenant_id", { length: TENANT_ID_LENGTH }).notNull(),
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
    uniqueIndex("providers_tenant_name_idx")
      .on(t.tenantId, t.name)
      .where(sql`${t.deletedAt} IS NULL`),
    index("providers_tenant_idx").on(t.tenantId),
  ],
);

// ---------------------------------------------------------------------------
// 6. document_types — (provider, name), e.g. Toysmith / "Nota Fiscal".
// Calibrate runs per TYPE, not per provider (§3.1).
// ---------------------------------------------------------------------------

export const documentTypes = pgTable(
  "document_types",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: varchar("tenant_id", { length: TENANT_ID_LENGTH }).notNull(),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => providers.id),
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
    uniqueIndex("document_types_provider_name_idx")
      .on(t.providerId, t.name)
      .where(sql`${t.deletedAt} IS NULL`),
    index("document_types_tenant_idx").on(t.tenantId),
    index("document_types_provider_idx").on(t.providerId),
  ],
);

// ---------------------------------------------------------------------------
// 7. extract_templates — the INPUT-side freeze, one per document type (§3.1).
//
// Three things are frozen together: the ordered field list (extract_fields),
// `input_mode` (a COST decision — native PDF costs ~5–20× an extracted text
// layer), and `detect_hint` (tier-1 substring detection, §3.3).
//
// There is NO extract-template versioning (§12.8, decided: invalidate).
// Recalibrating bumps `calibration_rev`, which participates in the extraction
// cache key `unique(s3_key, calibration_rev)` — so every affected document
// re-extracts (and is re-billed) on next use instead of serving stale JSON.
// ---------------------------------------------------------------------------

export const extractTemplates = pgTable(
  "extract_templates",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: varchar("tenant_id", { length: TENANT_ID_LENGTH }).notNull(),
    documentTypeId: uuid("document_type_id")
      .notNull()
      .references(() => documentTypes.id),
    // 'text' | 'vision' — cost, not capability (§3.1). No fallback ladder.
    inputMode: varchar("input_mode", { length: 10 }).notNull().default("text"),
    // string[] of distinctive substrings present on every doc of this type.
    detectHint: jsonb("detect_hint")
      .notNull()
      .default(sql`'[]'::jsonb`),
    // The confirmed calibration sample, kept as a golden fixture.
    fixtureS3Key: text("fixture_s3_key"),
    // Bumped on every recalibration. Part of the extraction cache key (§12.8).
    calibrationRev: integer("calibration_rev").notNull().default(1),
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
    // One live template per document type — Calibrate replaces, never forks.
    uniqueIndex("extract_templates_document_type_idx")
      .on(t.documentTypeId)
      .where(sql`${t.deletedAt} IS NULL`),
    index("extract_templates_tenant_idx").on(t.tenantId),
    check("extract_templates_input_mode_check", sql`${t.inputMode} IN ('text', 'vision')`),
    check("extract_templates_calibration_rev_check", sql`${t.calibrationRev} >= 1`),
  ],
);

// ---------------------------------------------------------------------------
// 8. extract_fields — the ordered field list. DATA, not a hand-written Zod
// schema: the validator is BUILT AT RUNTIME from these rows (poc/fields/spec.ts).
// `parent_field_id` carries the `object` / `object[]` nesting the POC needs for
// line items — a flat list cannot express `itens[].total`.
// ---------------------------------------------------------------------------

export const extractFields = pgTable(
  "extract_fields",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: varchar("tenant_id", { length: TENANT_ID_LENGTH }).notNull(),
    extractTemplateId: uuid("extract_template_id")
      .notNull()
      .references(() => extractTemplates.id),
    // Non-null only for children of an `object` / `object[]` field.
    parentFieldId: uuid("parent_field_id").references((): AnyPgColumn => extractFields.id),
    name: varchar({ length: 80 }).notNull(),
    type: varchar({ length: 20 }).notNull(),
    required: boolean().notNull().default(true),
    // What the model reads to re-find the label after a layout nudge (§3.1).
    description: text(),
    sortOrder: integer("sort_order").notNull().default(0),
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
    // Two partial indexes, not one on (template, parent, name): Postgres
    // treats NULLs as distinct, so a single index would let two TOP-LEVEL
    // fields share a name — and duplicate keys break the runtime-built Zod
    // schema. Split by parent nullability instead of relying on
    // NULLS NOT DISTINCT (PG 15+ only).
    uniqueIndex("extract_fields_template_root_name_idx")
      .on(t.extractTemplateId, t.name)
      .where(sql`${t.parentFieldId} IS NULL AND ${t.deletedAt} IS NULL`),
    uniqueIndex("extract_fields_template_parent_name_idx")
      .on(t.extractTemplateId, t.parentFieldId, t.name)
      .where(sql`${t.parentFieldId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    index("extract_fields_template_order_idx").on(t.extractTemplateId, t.sortOrder),
    index("extract_fields_tenant_idx").on(t.tenantId),
    index("extract_fields_parent_idx").on(t.parentFieldId),
    check(
      "extract_fields_type_check",
      sql`${t.type} IN (
        'string', 'money', 'date', 'integer', 'decimal', 'object', 'object[]'
      )`,
    ),
  ],
);
