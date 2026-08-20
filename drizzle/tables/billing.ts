// drizzle/tables/billing.ts
//
// Billing (decisions §7), ported from smartstocke's `api/billing/`. Key
// OWNERSHIP is stored, never a key; `ref_id` UNIQUE is the idempotency; the
// owed amount is frozen at write time and never recalculated.

import { sql } from "drizzle-orm";
import {
  pgTable,
  index,
  uuid,
  text,
  varchar,
  integer,
  numeric,
  jsonb,
  timestamp,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { TENANT_ID_LENGTH } from "./common";

// ---------------------------------------------------------------------------
// 17. ai_credentials — key OWNERSHIP, never a key (§7).
//
//   ssm_param_name IS NULL → platform key; raw = costFor(model, usage),
//                            owed = raw × multiplier, isPricedModel() ENFORCED
//                            ("unpriced is not free").
//   ssm_param_name SET     → BYOK; raw = 0, owed = 0, any model allowed.
//
// Customer keys live in SSM SecureString at
// `/reportflow/tenants/{org_id}/{provider}-api-key`. Postgres stores only the
// parameter NAME, which is not a secret — an RDS snapshot is worthless to an
// attacker. The CHECK pins the path prefix; the relay independently derives
// the allowed path from the job's tenant (§12.7) — the IAM wildcard alone is
// not the guard, and neither is this constraint.
// ---------------------------------------------------------------------------

export const aiCredentials = pgTable(
  "ai_credentials",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: varchar("tenant_id", { length: TENANT_ID_LENGTH }).notNull(),
    provider: varchar({ length: 40 }).notNull(),
    // The account-level default model for this provider (§6, "Model scope").
    model: varchar({ length: 80 }),
    ssmParamName: text("ssm_param_name"),
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
    uniqueIndex("ai_credentials_tenant_provider_idx").on(t.tenantId, t.provider),
    index("ai_credentials_tenant_idx").on(t.tenantId),
    check(
      "ai_credentials_ssm_param_name_check",
      sql`${t.ssmParamName} IS NULL OR ${t.ssmParamName} LIKE '/reportflow/tenants/%'`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 18. ai_charges — the per-call billing ledger, ported from smartstocke.
//
// `ref_id` is UNIQUE and that is the entire idempotency story under the
// collector's at-least-once delivery. It keys on the ARTIFACT, not the job —
// re-reading the same PDF must not bill twice, which is exactly what a user
// does when a read looks wrong — and it includes the PROVIDER (§12.6), because
// model names are not globally unique across providers:
//   report_extraction:{provider}:{model}:{s3Key}
//   report_analysis:{provider}:{model}:{templateVersionId}:{sortedExtractionIds}
//   report_verify:{provider}:{model}:{refKey}
//
// `owed_usd_cents` is frozen at write time and NEVER recalculated: changing
// the multiplier must not silently reprice history.
// ---------------------------------------------------------------------------

export const aiCharges = pgTable(
  "ai_charges",
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tenantId: varchar("tenant_id", { length: TENANT_ID_LENGTH }).notNull(),
    // Which hop spent the credit: 'extract' | 'analyse' | 'detect' | 'verify'.
    source: varchar({ length: 40 }).notNull(),
    provider: varchar({ length: 40 }).notNull(),
    model: varchar({ length: 80 }).notNull(),
    refId: text("ref_id").notNull(),
    // Canonical relay usage envelope: { input_tokens, output_tokens, … }.
    // jsonb, not two integer columns, because `costFor()` must keep working
    // when a provider reports cache-read / thinking tokens we do not model yet.
    usage: jsonb()
      .notNull()
      .default(sql`'{}'::jsonb`),
    rawUsdCents: numeric("raw_usd_cents", { precision: 12, scale: 4 }).notNull(),
    multX100: integer("mult_x100").notNull(),
    owedUsdCents: numeric("owed_usd_cents", { precision: 12, scale: 4 }).notNull(),
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
    uniqueIndex("ai_charges_ref_id_idx").on(t.refId),
    index("ai_charges_tenant_created_idx").on(t.tenantId, t.createdAt),
  ],
);

// ---------------------------------------------------------------------------
// 19. credit_config — deployment-wide knobs for the ai_charges ledger
// (`mult.<source>` rows). Registered `global`: no tenant_id, visible to the
// platform admin only, and — like smartstocke's — the one table whose primary
// key is not a uuid.
// ---------------------------------------------------------------------------

export const creditConfig = pgTable("credit_config", {
  key: text().primaryKey().notNull(),
  valueInt: integer("value_int").notNull(),
  description: text(),
});
