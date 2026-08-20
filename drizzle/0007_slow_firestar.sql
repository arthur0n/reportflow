-- M-04: collapse dre_groups + categories into list_of_values; add audit_logs.

-- ────────────────────────────────────────────────────────────────────────────
-- 1. Drop FK constraints on dependent tables that point at the soon-to-be-
--    dropped categories/dre_groups. Drop their indexes too. This must precede
--    the DROP TABLEs so we don't rely on CASCADE.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE "category_templates"
  DROP CONSTRAINT "category_templates_dre_group_code_dre_groups_code_fk";--> statement-breakpoint
ALTER TABLE "creditors"
  DROP CONSTRAINT "creditors_default_category_id_categories_id_fk";--> statement-breakpoint
ALTER TABLE "transactions"
  DROP CONSTRAINT "transactions_category_id_categories_id_fk";--> statement-breakpoint
ALTER TABLE "transactions"
  DROP CONSTRAINT "transactions_dre_group_code_dre_groups_code_fk";--> statement-breakpoint

DROP INDEX "transactions_tenant_accrual_dre_idx";--> statement-breakpoint
DROP INDEX "lov_is_active_idx";--> statement-breakpoint
DROP INDEX "lov_tenant_id_idx";--> statement-breakpoint
DROP INDEX "lov_code_type_language_tenant_idx";--> statement-breakpoint

ALTER TABLE "transactions" DROP COLUMN "dre_group_code";--> statement-breakpoint
ALTER TABLE "list_of_values" DROP COLUMN "category";--> statement-breakpoint
ALTER TABLE "list_of_values" DROP COLUMN "is_system";--> statement-breakpoint
ALTER TABLE "list_of_values" DROP COLUMN "is_active";--> statement-breakpoint
ALTER TABLE "list_of_values" DROP COLUMN "updated_at";--> statement-breakpoint

DROP TABLE "categories";--> statement-breakpoint
DROP TABLE "dre_groups";--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 2. Add columns to list_of_values for the canonical-lookup pattern.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE "list_of_values" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "list_of_values" ADD COLUMN "parent_lov" uuid;--> statement-breakpoint
ALTER TABLE "list_of_values" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "list_of_values" ADD COLUMN "last_upd_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "list_of_values" ADD COLUMN "last_upd_by" uuid;--> statement-breakpoint
ALTER TABLE "list_of_values" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "list_of_values" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 3. Create audit_logs.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entity_type" varchar(40) NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" varchar(20) NOT NULL,
	"field_name" text,
	"old_value" text,
	"new_value" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"last_upd_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_upd_by" uuid NOT NULL,
	CONSTRAINT "audit_logs_action_check" CHECK ("audit_logs"."action" IN ('create', 'update', 'delete', 'restore', 'reclassify'))
);--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 4. New FK constraints (now pointing at list_of_values, not categories).
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE "audit_logs"
  ADD CONSTRAINT "audit_logs_tenant_id_tenants_id_fk"
  FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "list_of_values"
  ADD CONSTRAINT "list_of_values_parent_lov_list_of_values_id_fk"
  FOREIGN KEY ("parent_lov") REFERENCES "public"."list_of_values"("id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "creditors"
  ADD CONSTRAINT "creditors_default_category_id_list_of_values_id_fk"
  FOREIGN KEY ("default_category_id") REFERENCES "public"."list_of_values"("id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint

ALTER TABLE "transactions"
  ADD CONSTRAINT "transactions_category_id_list_of_values_id_fk"
  FOREIGN KEY ("category_id") REFERENCES "public"."list_of_values"("id")
  ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ────────────────────────────────────────────────────────────────────────────
-- 5. New indexes.
-- ────────────────────────────────────────────────────────────────────────────

CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree
  ("tenant_id","entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_created_idx" ON "audit_logs" USING btree
  ("tenant_id","created_at");--> statement-breakpoint

CREATE UNIQUE INDEX "lov_code_type_language_tenant_idx" ON "list_of_values" USING btree
  ("code","type","language","tenant_id")
  WHERE "list_of_values"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "lov_tenant_type_value_idx" ON "list_of_values" USING btree
  ("tenant_id","type",lower("value"))
  WHERE "list_of_values"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "lov_tenant_type_idx" ON "list_of_values" USING btree
  ("tenant_id","type");--> statement-breakpoint
CREATE INDEX "lov_parent_lov_idx" ON "list_of_values" USING btree
  ("parent_lov");--> statement-breakpoint
CREATE INDEX "lov_type_parent_idx" ON "list_of_values" USING btree
  ("type","parent_lov");--> statement-breakpoint

CREATE INDEX "transactions_tenant_accrual_category_idx" ON "transactions" USING btree
  ("tenant_id","accrual_date","category_id");
