// drizzle/tables/pipeline.ts
//
// The runtime artifacts (decisions §4, §5): who the report is about, the PDF,
// the cached extraction, the report, its named-role bindings, and the async
// job rows the UI polls.

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
import { documentTypes, extractTemplates } from "./calibration";
import { outboundTemplateVersions } from "./outbound";

// ---------------------------------------------------------------------------
// 11. clients — the ACCOUNT's own customers; the people a report is ABOUT.
// They never log in (§2). Vocabulary is fixed: account = Clerk org, client = row.
// ---------------------------------------------------------------------------

export const clients = pgTable(
  "clients",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: varchar("tenant_id", { length: TENANT_ID_LENGTH }).notNull(),
    name: varchar({ length: 160 }).notNull(),
    // Tax id as printed (CNPJ/CPF/NIF) — kept verbatim, never normalised here.
    taxId: varchar("tax_id", { length: 40 }),
    email: varchar({ length: 320 }),
    notes: text(),
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
    uniqueIndex("clients_tenant_name_idx")
      .on(t.tenantId, t.name)
      .where(sql`${t.deletedAt} IS NULL`),
    index("clients_tenant_idx").on(t.tenantId),
  ],
);

// ---------------------------------------------------------------------------
// 12. documents — an uploaded PDF.
//
// `s3_key` is minted SERVER-side (§12.5) as `{org}/{uuid}.pdf`; the client
// never supplies it, and `assertOwnedKey` re-checks ownership on every use.
// It is globally unique, which is also what makes the extraction cache key
// (`s3_key`, `calibration_rev`) meaningful across the whole deployment.
//
// `file_id` is the provider Files API handle. It is scoped to (provider, API
// key owner) (§12.3), so it is NEVER stored without `file_provider` — the
// CHECK enforces that pairing rather than trusting call sites.
//
// `detected_by` records which of the three §3.3 tiers produced the type:
// 'hint' (free substring match), 'model' (one cheap classification hop), or
// 'manual' (the always-present, always-correctable dropdown).
//
// `detect_job_id` is the CURRENCY GUARD for tier 2 (codex review, 2026-08-20):
// it names the most recently enqueued `detect` job for this document. A
// second `documents.detect` call while one is still pending reuses that job
// rather than enqueueing a duplicate (api/services/detection-service.ts
// `loadPendingDetectJob`); resolving a job's result checks
// `job.id === documents.detect_job_id` first, so an OLDER job that finishes
// late — after a newer job, or after tier 1/manual already answered — is
// rejected as stale instead of overwriting a newer answer. FK to
// `report_jobs.id` (forward-referenced via a lazy callback: report_jobs is
// declared later in this same file) rather than a bare uuid, so a stale id
// can never point at a row that was never actually a job.
// ---------------------------------------------------------------------------

export const documents = pgTable(
  "documents",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: varchar("tenant_id", { length: TENANT_ID_LENGTH }).notNull(),
    clientId: uuid("client_id").references(() => clients.id),
    s3Key: text("s3_key").notNull(),
    fileName: text("file_name"),
    byteSize: integer("byte_size"),
    // Provider Files API handle + the provider it belongs to. Both or neither.
    fileId: varchar("file_id", { length: 128 }),
    fileProvider: varchar("file_provider", { length: 40 }),
    // NULL until detection runs; always correctable before extraction (§3.3).
    documentTypeId: uuid("document_type_id").references(() => documentTypes.id),
    detectedBy: varchar("detected_by", { length: 10 }),
    detectJobId: uuid("detect_job_id").references((): AnyPgColumn => reportJobs.id),
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
    uniqueIndex("documents_s3_key_idx").on(t.s3Key),
    index("documents_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("documents_tenant_type_idx").on(t.tenantId, t.documentTypeId),
    index("documents_client_idx").on(t.clientId),
    check(
      "documents_detected_by_check",
      sql`${t.detectedBy} IS NULL OR ${t.detectedBy} IN ('hint', 'model', 'manual')`,
    ),
    // §12.3 — a file_id without its provider is a handle you cannot safely use.
    check(
      "documents_file_provider_pairing_check",
      sql`(${t.fileId} IS NULL) = (${t.fileProvider} IS NULL)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 13. extractions — hop 1's validated JSON. Append-only, cached, idempotent.
//
// `unique(s3_key, calibration_rev)` (§12.8) is the whole caching contract:
// re-reading the same PDF under the same calibration must not bill twice, and
// a recalibration invalidates by bumping the rev rather than by deleting rows.
//
// `corrected` marks a `revisar` repair (§4.2): the human-fixed extraction is
// persisted and NEVER re-run — the fix is permanent and free.
// ---------------------------------------------------------------------------

export const extractions = pgTable(
  "extractions",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: varchar("tenant_id", { length: TENANT_ID_LENGTH }).notNull(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id),
    extractTemplateId: uuid("extract_template_id")
      .notNull()
      .references(() => extractTemplates.id),
    // Denormalised from documents.s3_key so the cache key is a single-table
    // constraint the collector can honour with ON CONFLICT DO NOTHING (§12.1).
    s3Key: text("s3_key").notNull(),
    calibrationRev: integer("calibration_rev").notNull(),
    // The validated payload — Zod-checked against the runtime-built schema.
    data: jsonb().notNull(),
    provider: varchar({ length: 40 }),
    model: varchar({ length: 80 }),
    corrected: boolean().notNull().default(false),
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
    uniqueIndex("extractions_s3_key_calibration_rev_idx").on(t.s3Key, t.calibrationRev),
    index("extractions_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("extractions_document_idx").on(t.documentId),
    index("extractions_template_idx").on(t.extractTemplateId),
    check("extractions_calibration_rev_check", sql`${t.calibrationRev} >= 1`),
  ],
);

// ---------------------------------------------------------------------------
// 14. reports — source of truth is `content_json` (§5.1).
//
// Drafts render live from JSON + the pinned template version, so template
// fixes reach drafts that opt in. On publish the rendered HTML is frozen to S3
// and the key stored: editing the shell later cannot retroactively change a
// document someone's customer already received.
//
// `frozen_at IS NOT NULL` IS the published state — there is no separate status
// column to drift out of sync with the artifact.
// ---------------------------------------------------------------------------

export const reports = pgTable(
  "reports",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: varchar("tenant_id", { length: TENANT_ID_LENGTH }).notNull(),
    clientId: uuid("client_id").references(() => clients.id),
    // Pinned version, never the template — updating a draft is explicit (§5.3).
    templateVersionId: uuid("template_version_id")
      .notNull()
      .references(() => outboundTemplateVersions.id),
    title: varchar({ length: 200 }),
    // { slots: { <slug>: { text, edited } }, … } — §5.2.
    contentJson: jsonb("content_json")
      .notNull()
      .default(sql`'{}'::jsonb`),
    frozenHtmlS3Key: text("frozen_html_s3_key"),
    frozenAt: timestamp("frozen_at", { withTimezone: true, mode: "string" }),
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
    index("reports_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("reports_tenant_client_idx").on(t.tenantId, t.clientId),
    index("reports_template_version_idx").on(t.templateVersionId),
    uniqueIndex("reports_frozen_html_s3_key_idx")
      .on(t.frozenHtmlS3Key)
      .where(sql`${t.frozenHtmlS3Key} IS NOT NULL`),
    // A frozen report has both halves or neither.
    check(
      "reports_frozen_pairing_check",
      sql`(${t.frozenAt} IS NULL) = (${t.frozenHtmlS3Key} IS NULL)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 15. report_documents — the named-role join (§3.2).
//
// Documents are addressed BY ROLE, never by index: `docs[0]` cannot tell an
// invoice from a contract, and flattening every document into one namespace
// collides silently on shared field names like `total`. `role_key` matches a
// key declared in the pinned version's `inputs_json`; a required role with no
// row is what makes "aguardando: contrato" a showable state.
//
// Uniqueness is (report_id, role_key, extraction_id) per §8 — NOT
// (report_id, role_key) — because a role may declare cardinality 'many'
// (poc/template/declaration.ts binds several faturas to one role).
// ---------------------------------------------------------------------------

export const reportDocuments = pgTable(
  "report_documents",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: varchar("tenant_id", { length: TENANT_ID_LENGTH }).notNull(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    extractionId: uuid("extraction_id")
      .notNull()
      .references(() => extractions.id),
    roleKey: varchar("role_key", { length: 50 }).notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
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
    uniqueIndex("report_documents_report_role_extraction_idx").on(
      t.reportId,
      t.roleKey,
      t.extractionId,
    ),
    index("report_documents_report_role_idx").on(t.reportId, t.roleKey, t.sortOrder),
    index("report_documents_tenant_idx").on(t.tenantId),
    index("report_documents_extraction_idx").on(t.extractionId),
  ],
);

// ---------------------------------------------------------------------------
// 16. report_jobs — the async unit of work. Append-only; the UI polls THIS ROW,
// never S3 (§4).
//
// Two writers (collector + poll backstop) under at-least-once S3 events, so
// transitions are compare-and-set and status only moves FORWARD:
// pending → revisar | done | failed (§12.1). `attempt` is embedded in the S3
// result key, which is why `s3_key` is globally unique: a retry mints a new
// key rather than racing the previous attempt's collector.
// ---------------------------------------------------------------------------

export const reportJobs = pgTable(
  "report_jobs",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: varchar("tenant_id", { length: TENANT_ID_LENGTH }).notNull(),
    kind: varchar({ length: 20 }).notNull(),
    status: varchar({ length: 20 }).notNull().default("pending"),
    // The OUTBOX JOB key for the attempt currently in flight —
    // `jobs/{tenantId}/{jobId}.json` (api/lib/relay.ts). The result key is
    // DERIVED from it, never stored: two columns holding the same two facts
    // are two columns that can disagree.
    s3Key: text("s3_key").notNull(),
    // The attempt currently in flight, 1-based, and always equal to the `-a{n}`
    // suffix of the jobId inside `s3_key` (api/lib/relay.ts `mintJobId`). This
    // is what makes §12.1's stale-attempt rejection possible: a result whose
    // key carries a LOWER attempt than this column is the answer to work that
    // has already been superseded, and the collector drops it without opening
    // the file. A retry UPDATES this row (new `s3_key`, attempt + 1) rather
    // than inserting a second one — the UI polls one row for the life of the
    // work, and `unique(s3_key)` still holds because the key carries the
    // attempt. 0 is the pre-enqueue default, never an in-flight value.
    attempt: integer().notNull().default(0),
    error: text(),
    // The canonical job payload (§6) as enqueued, kept so the COLLECTOR can
    // re-enqueue attempt n+1 without being able to compose one. It cannot
    // compose one: the relay DELETES `jobs/{…}.json` once it has written a
    // result, and rebuilding the prompt would mean the collector owning the
    // field list, the template and the model choice — i.e. not being thin.
    // §4.2's "auto-retry once" is only implementable with this column.
    request: jsonb(),
    // The relay result verbatim (`{content,usage,model,provider}` or
    // `{error:{type,message}}`), written by whichever of the two writers —
    // collector or poll backstop — wins the transition. Raw on purpose: what
    // the model actually said is the evidence for every downstream decision,
    // and a parsed-and-discarded copy cannot be re-read after a bug.
    result: jsonb(),
    // Optional back-references — a detect/extract job predates any report.
    documentId: uuid("document_id").references(() => documents.id),
    // No action, not cascade: report_jobs is the append-only job/status
    // history (§12.1), not a join row. report_documents cascades because it
    // dies with its report; a job history row should never silently
    // disappear alongside the report it describes.
    reportId: uuid("report_id").references(() => reports.id),
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
    uniqueIndex("report_jobs_s3_key_idx").on(t.s3Key),
    // ONE PENDING EXTRACT PER DOCUMENT, enforced by Postgres rather than by a
    // read (codex review, 2026-08-20). `startExtraction` used to preflight
    // with a SELECT for an in-flight job and then INSERT — check-then-act, so
    // two concurrent calls (a double-clicked [Extrair], two tabs, a retried
    // request) both read "nothing pending" and both enqueued a PAID hop. The
    // §12.8 cache does not save you here: neither extraction exists yet, so
    // both jobs run and both are billed.
    //
    // A partial unique index is the fix because the constraint is genuinely
    // partial: `pending` is the only status that may not repeat. A document
    // accumulates any number of settled extract jobs over its life (a retry
    // that failed, a re-extraction after a recalibration), and a total unique
    // index would forbid the second one forever.
    //
    // The insert then carries ON CONFLICT DO NOTHING and the LOSER re-reads
    // the winner's row — so the loser returns the same jobId the winner did,
    // and the caller cannot tell which of them it was.
    uniqueIndex("report_jobs_pending_extract_idx")
      .on(t.tenantId, t.documentId)
      .where(sql`${t.status} = 'pending' AND ${t.kind} = 'extract'`),
    index("report_jobs_tenant_status_idx").on(t.tenantId, t.status),
    index("report_jobs_tenant_created_idx").on(t.tenantId, t.createdAt),
    index("report_jobs_document_idx").on(t.documentId),
    index("report_jobs_report_idx").on(t.reportId),
    check("report_jobs_kind_check", sql`${t.kind} IN ('detect', 'extract', 'analyse', 'verify')`),
    check("report_jobs_status_check", sql`${t.status} IN ('pending', 'revisar', 'done', 'failed')`),
    check("report_jobs_attempt_check", sql`${t.attempt} >= 0`),
  ],
);
