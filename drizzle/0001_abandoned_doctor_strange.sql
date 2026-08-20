CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" varchar(20) DEFAULT 'checking' NOT NULL,
	"opening_balance" bigint DEFAULT 0 NOT NULL,
	"opening_date" date,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "bank_accounts_kind_check" CHECK ("bank_accounts"."kind" IN ('cash_drawer', 'checking', 'savings', 'credit_card'))
);
--> statement-breakpoint
CREATE TABLE "business_units" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" varchar(20) DEFAULT 'other' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "business_units_kind_check" CHECK ("business_units"."kind" IN ('restaurant', 'bar', 'holding', 'distribution', 'other'))
);
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"template_id" uuid,
	"dre_group_code" varchar(10) NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "category_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"industry" text DEFAULT 'restaurant' NOT NULL,
	"dre_group_code" varchar(10) NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"display_order" smallint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "creditors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"name_normalized" text NOT NULL,
	"document" varchar(20),
	"default_category_id" uuid,
	"is_customer" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dre_groups" (
	"code" varchar(10) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" varchar(20) NOT NULL,
	"sign" smallint NOT NULL,
	"display_order" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "dre_groups_sign_check" CHECK ("dre_groups"."sign" IN (-1, 0, 1))
);
--> statement-breakpoint
CREATE TABLE "payment_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" varchar(20) DEFAULT 'transfer' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "payment_methods_kind_check" CHECK ("payment_methods"."kind" IN ('cash', 'card', 'transfer', 'cheque'))
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"external_id" varchar(64) NOT NULL,
	"name" text NOT NULL,
	"cnpj" varchar(18),
	"industry" text DEFAULT 'restaurant' NOT NULL,
	"fiscal_year_start" smallint DEFAULT 1 NOT NULL,
	"timezone" text DEFAULT 'America/Sao_Paulo' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "tenants_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE "transaction_types" (
	"code" varchar(30) PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"affects_dre" boolean DEFAULT true NOT NULL,
	"display_order" smallint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"business_unit_id" uuid NOT NULL,
	"transaction_type" varchar(30) NOT NULL,
	"creditor_id" uuid,
	"category_id" uuid,
	"dre_group_code" varchar(10),
	"payment_method_id" uuid,
	"bank_account_id" uuid,
	"accrual_date" date NOT NULL,
	"due_date" date NOT NULL,
	"actual_date" date,
	"forecast_amount" bigint NOT NULL,
	"actual_amount" bigint,
	"interest_amount" bigint DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'ESTIMADO' NOT NULL,
	"description" text,
	"installment_ref" varchar(20),
	"external_id" varchar(100),
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"deletion_reason" text,
	CONSTRAINT "transactions_due_after_accrual_check" CHECK ("transactions"."due_date" >= "transactions"."accrual_date"),
	CONSTRAINT "transactions_forecast_nonzero_check" CHECK ("transactions"."forecast_amount" != 0),
	CONSTRAINT "transactions_actual_sign_check" CHECK ("transactions"."actual_amount" IS NULL OR ("transactions"."actual_amount" > 0) = ("transactions"."forecast_amount" > 0))
);
--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "open_id" TO "external_id";--> statement-breakpoint
DROP INDEX "users_open_id_tenant_id_idx";--> statement-breakpoint
DROP INDEX "lov_code_type_language_tenant_idx";--> statement-breakpoint
DROP INDEX "lov_is_active_idx";--> statement-breakpoint
DROP INDEX "lov_tenant_id_idx";--> statement-breakpoint
DROP INDEX "lov_type_idx";--> statement-breakpoint
DROP INDEX "users_tenant_id_idx";--> statement-breakpoint
-- Migrate existing varchar tenant_ids to uuid via the new tenants table.
-- Existing values are auth provider org IDs (e.g. "org_2abc..."), not UUIDs.
-- Strategy: insert tenant rows for existing orgs, then swap columns.

INSERT INTO tenants (external_id, name)
SELECT DISTINCT tenant_id, tenant_id
FROM users
WHERE tenant_id IS NOT NULL AND tenant_id != ''
ON CONFLICT DO NOTHING;--> statement-breakpoint

INSERT INTO tenants (external_id, name)
SELECT DISTINCT tenant_id::varchar, tenant_id::varchar
FROM list_of_values
WHERE tenant_id IS NOT NULL AND tenant_id::varchar != ''
  AND tenant_id::varchar NOT IN (SELECT external_id FROM tenants)
ON CONFLICT DO NOTHING;--> statement-breakpoint

-- users: swap tenant_id varchar → uuid
ALTER TABLE "users" ADD COLUMN "tenant_id_new" uuid;--> statement-breakpoint
UPDATE "users" SET "tenant_id_new" = t.id FROM tenants t WHERE t.external_id = "users".tenant_id::varchar;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "tenant_id";--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "tenant_id_new" TO "tenant_id";--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "tenant_id" SET NOT NULL;--> statement-breakpoint

-- list_of_values: swap tenant_id varchar → uuid (nullable)
ALTER TABLE "list_of_values" ADD COLUMN "tenant_id_new" uuid;--> statement-breakpoint
UPDATE "list_of_values" SET "tenant_id_new" = t.id FROM tenants t WHERE t.external_id = "list_of_values".tenant_id::varchar;--> statement-breakpoint
ALTER TABLE "list_of_values" DROP COLUMN "tenant_id";--> statement-breakpoint
ALTER TABLE "list_of_values" RENAME COLUMN "tenant_id_new" TO "tenant_id";--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_units" ADD CONSTRAINT "business_units_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_template_id_category_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."category_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "categories" ADD CONSTRAINT "categories_dre_group_code_dre_groups_code_fk" FOREIGN KEY ("dre_group_code") REFERENCES "public"."dre_groups"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "category_templates" ADD CONSTRAINT "category_templates_dre_group_code_dre_groups_code_fk" FOREIGN KEY ("dre_group_code") REFERENCES "public"."dre_groups"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creditors" ADD CONSTRAINT "creditors_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "creditors" ADD CONSTRAINT "creditors_default_category_id_categories_id_fk" FOREIGN KEY ("default_category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_methods" ADD CONSTRAINT "payment_methods_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_business_unit_id_business_units_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_transaction_type_transaction_types_code_fk" FOREIGN KEY ("transaction_type") REFERENCES "public"."transaction_types"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_creditor_id_creditors_id_fk" FOREIGN KEY ("creditor_id") REFERENCES "public"."creditors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_dre_group_code_dre_groups_code_fk" FOREIGN KEY ("dre_group_code") REFERENCES "public"."dre_groups"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_payment_method_id_payment_methods_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."payment_methods"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_tenant_name_idx" ON "bank_accounts" USING btree ("tenant_id","name") WHERE "bank_accounts"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "bank_accounts_tenant_active_idx" ON "bank_accounts" USING btree ("tenant_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "business_units_tenant_name_idx" ON "business_units" USING btree ("tenant_id","name") WHERE "business_units"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "business_units_tenant_active_idx" ON "business_units" USING btree ("tenant_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "categories_tenant_name_idx" ON "categories" USING btree ("tenant_id","name") WHERE "categories"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "categories_tenant_dre_group_idx" ON "categories" USING btree ("tenant_id","dre_group_code");--> statement-breakpoint
CREATE INDEX "categories_tenant_active_idx" ON "categories" USING btree ("tenant_id","is_active");--> statement-breakpoint
CREATE INDEX "category_templates_industry_dre_group_idx" ON "category_templates" USING btree ("industry","dre_group_code");--> statement-breakpoint
CREATE INDEX "category_templates_industry_idx" ON "category_templates" USING btree ("industry");--> statement-breakpoint
CREATE UNIQUE INDEX "creditors_tenant_name_normalized_idx" ON "creditors" USING btree ("tenant_id","name_normalized") WHERE "creditors"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "creditors_tenant_active_idx" ON "creditors" USING btree ("tenant_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_methods_tenant_name_idx" ON "payment_methods" USING btree ("tenant_id","name") WHERE "payment_methods"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "payment_methods_tenant_active_idx" ON "payment_methods" USING btree ("tenant_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_cnpj_idx" ON "tenants" USING btree ("cnpj") WHERE "tenants"."cnpj" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "transactions_tenant_bu_accrual_idx" ON "transactions" USING btree ("tenant_id","business_unit_id","accrual_date");--> statement-breakpoint
CREATE INDEX "transactions_tenant_bu_due_idx" ON "transactions" USING btree ("tenant_id","business_unit_id","due_date");--> statement-breakpoint
CREATE INDEX "transactions_tenant_creditor_idx" ON "transactions" USING btree ("tenant_id","creditor_id");--> statement-breakpoint
CREATE INDEX "transactions_tenant_status_idx" ON "transactions" USING btree ("tenant_id","status") WHERE "transactions"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "transactions_tenant_accrual_dre_idx" ON "transactions" USING btree ("tenant_id","accrual_date","dre_group_code");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_external_id_tenant_id_idx" ON "users" USING btree ("external_id","tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lov_code_type_language_tenant_idx" ON "list_of_values" USING btree ("code","type","language","tenant_id");--> statement-breakpoint
CREATE INDEX "lov_is_active_idx" ON "list_of_values" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "lov_tenant_id_idx" ON "list_of_values" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "lov_type_idx" ON "list_of_values" USING btree ("type");--> statement-breakpoint
CREATE INDEX "users_tenant_id_idx" ON "users" USING btree ("tenant_id");