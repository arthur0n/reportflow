// drizzle/schema.ts
//
// The schema barrel. Table definitions live in `drizzle/tables/`, grouped by
// the design axis they belong to; drizzle-kit, the scoped DB helper, and the
// TABLE_SCOPE completeness test all read them through this file.
//
//   tables/common.ts       — TENANT_ID_LENGTH (Clerk org_id column facts)
//   tables/tenancy.ts      — 1–4   users, list_of_values, tenant_values, audit_logs
//   tables/calibration.ts  — 5–8   providers, document_types, extract_templates,
//                                  extract_fields          (INPUT axis, §3.1)
//   tables/outbound.ts     — 9–10  outbound_templates, outbound_template_versions
//                                                          (OUTPUT axis, §3.2/§5.3)
//   tables/pipeline.ts     — 11–16 clients, documents, extractions, reports,
//                                  report_documents, report_jobs   (§4, §5)
//   tables/billing.ts      — 17–19 ai_credentials, ai_charges, credit_config (§7)
//
// Tenancy (project_conventions §6): `tenant_id === Clerk org_id`. A tenant is a
// Clerk organization, not a local row — there is no `tenants` table and no
// `memberships` table. `tenant_id` is therefore ALWAYS `varchar(64)` (an opaque
// string like `org_2abc…`), never `uuid`, and never a foreign key. Intra-domain
// FKs (document_type_id, report_id, …) are ordinary uuid FKs and are wanted.
//
// Convention: every new table MUST also get a TABLE_SCOPE entry in
// api/db/scope.ts — `conditions()` throws on an unregistered table
// (decisions §12.9), so a forgotten entry is a dev-time crash, not a leak.
// api/db/scope.test.ts reflects over THIS module and fails on any table that
// is missing from the registry (or registered but no longer in the schema).

export { TENANT_ID_LENGTH } from "./tables/common";
export { users, listOfValues, tenantValues, auditLogs } from "./tables/tenancy";
export { providers, documentTypes, extractTemplates, extractFields } from "./tables/calibration";
export { outboundTemplates, outboundTemplateVersions } from "./tables/outbound";
export {
  clients,
  documents,
  extractions,
  reports,
  reportDocuments,
  reportJobs,
} from "./tables/pipeline";
export { aiCredentials, aiCharges, creditConfig } from "./tables/billing";
