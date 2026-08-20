CREATE TABLE "ai_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"source" varchar(40) NOT NULL,
	"provider" varchar(40) NOT NULL,
	"model" varchar(80) NOT NULL,
	"ref_id" text NOT NULL,
	"usage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw_usd_cents" numeric(12, 4) NOT NULL,
	"mult_x100" integer NOT NULL,
	"owed_usd_cents" numeric(12, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"last_upd_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_upd_by" uuid
);
--> statement-breakpoint
CREATE TABLE "ai_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"provider" varchar(40) NOT NULL,
	"model" varchar(80),
	"ssm_param_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"last_upd_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_upd_by" uuid,
	CONSTRAINT "ai_credentials_ssm_param_name_check" CHECK ("ai_credentials"."ssm_param_name" IS NULL OR "ai_credentials"."ssm_param_name" LIKE '/reportflow/tenants/%')
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"name" varchar(160) NOT NULL,
	"tax_id" varchar(40),
	"email" varchar(320),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"last_upd_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_upd_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "credit_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value_int" integer NOT NULL,
	"description" text
);
--> statement-breakpoint
CREATE TABLE "document_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"provider_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"last_upd_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_upd_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"client_id" uuid,
	"s3_key" text NOT NULL,
	"file_name" text,
	"byte_size" integer,
	"file_id" varchar(128),
	"file_provider" varchar(40),
	"document_type_id" uuid,
	"detected_by" varchar(10),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"last_upd_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_upd_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "documents_detected_by_check" CHECK ("documents"."detected_by" IS NULL OR "documents"."detected_by" IN ('hint', 'model', 'manual')),
	CONSTRAINT "documents_file_provider_pairing_check" CHECK (("documents"."file_id" IS NULL) = ("documents"."file_provider" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "extract_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"extract_template_id" uuid NOT NULL,
	"parent_field_id" uuid,
	"name" varchar(80) NOT NULL,
	"type" varchar(20) NOT NULL,
	"required" boolean DEFAULT true NOT NULL,
	"description" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"last_upd_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_upd_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "extract_fields_type_check" CHECK ("extract_fields"."type" IN (
        'string', 'money', 'date', 'integer', 'decimal', 'object', 'object[]'
      ))
);
--> statement-breakpoint
CREATE TABLE "extract_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"document_type_id" uuid NOT NULL,
	"input_mode" varchar(10) DEFAULT 'text' NOT NULL,
	"detect_hint" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fixture_s3_key" text,
	"calibration_rev" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"last_upd_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_upd_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "extract_templates_input_mode_check" CHECK ("extract_templates"."input_mode" IN ('text', 'vision')),
	CONSTRAINT "extract_templates_calibration_rev_check" CHECK ("extract_templates"."calibration_rev" >= 1)
);
--> statement-breakpoint
CREATE TABLE "extractions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"document_id" uuid NOT NULL,
	"extract_template_id" uuid NOT NULL,
	"s3_key" text NOT NULL,
	"calibration_rev" integer NOT NULL,
	"data" jsonb NOT NULL,
	"provider" varchar(40),
	"model" varchar(80),
	"corrected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"last_upd_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_upd_by" uuid,
	CONSTRAINT "extractions_calibration_rev_check" CHECK ("extractions"."calibration_rev" >= 1)
);
--> statement-breakpoint
CREATE TABLE "outbound_template_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outbound_template_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"html" text NOT NULL,
	"slots_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inputs_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"last_upd_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_upd_by" uuid,
	CONSTRAINT "outbound_template_versions_version_check" CHECK ("outbound_template_versions"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "outbound_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(64),
	"name" varchar(120) NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"last_upd_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_upd_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"name" varchar(120) NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"last_upd_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_upd_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "report_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"report_id" uuid NOT NULL,
	"extraction_id" uuid NOT NULL,
	"role_key" varchar(50) NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"last_upd_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_upd_by" uuid
);
--> statement-breakpoint
CREATE TABLE "report_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"s3_key" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"error" text,
	"document_id" uuid,
	"report_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"last_upd_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_upd_by" uuid,
	CONSTRAINT "report_jobs_kind_check" CHECK ("report_jobs"."kind" IN ('detect', 'extract', 'analyse', 'verify')),
	CONSTRAINT "report_jobs_status_check" CHECK ("report_jobs"."status" IN ('pending', 'revisar', 'done', 'failed')),
	CONSTRAINT "report_jobs_attempt_check" CHECK ("report_jobs"."attempt" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"client_id" uuid,
	"template_version_id" uuid NOT NULL,
	"title" varchar(200),
	"content_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"frozen_html_s3_key" text,
	"frozen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"last_upd_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_upd_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "reports_frozen_pairing_check" CHECK (("reports"."frozen_at" IS NULL) = ("reports"."frozen_html_s3_key" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "document_types" ADD CONSTRAINT "document_types_provider_id_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."providers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_document_type_id_document_types_id_fk" FOREIGN KEY ("document_type_id") REFERENCES "public"."document_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extract_fields" ADD CONSTRAINT "extract_fields_extract_template_id_extract_templates_id_fk" FOREIGN KEY ("extract_template_id") REFERENCES "public"."extract_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extract_fields" ADD CONSTRAINT "extract_fields_parent_field_id_extract_fields_id_fk" FOREIGN KEY ("parent_field_id") REFERENCES "public"."extract_fields"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extract_templates" ADD CONSTRAINT "extract_templates_document_type_id_document_types_id_fk" FOREIGN KEY ("document_type_id") REFERENCES "public"."document_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extractions" ADD CONSTRAINT "extractions_extract_template_id_extract_templates_id_fk" FOREIGN KEY ("extract_template_id") REFERENCES "public"."extract_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_template_versions" ADD CONSTRAINT "outbound_template_versions_outbound_template_id_outbound_templates_id_fk" FOREIGN KEY ("outbound_template_id") REFERENCES "public"."outbound_templates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_documents" ADD CONSTRAINT "report_documents_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_documents" ADD CONSTRAINT "report_documents_extraction_id_extractions_id_fk" FOREIGN KEY ("extraction_id") REFERENCES "public"."extractions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_jobs" ADD CONSTRAINT "report_jobs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_jobs" ADD CONSTRAINT "report_jobs_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_template_version_id_outbound_template_versions_id_fk" FOREIGN KEY ("template_version_id") REFERENCES "public"."outbound_template_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_charges_ref_id_idx" ON "ai_charges" USING btree ("ref_id");--> statement-breakpoint
CREATE INDEX "ai_charges_tenant_created_idx" ON "ai_charges" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_credentials_tenant_provider_idx" ON "ai_credentials" USING btree ("tenant_id","provider");--> statement-breakpoint
CREATE INDEX "ai_credentials_tenant_idx" ON "ai_credentials" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_tenant_name_idx" ON "clients" USING btree ("tenant_id","name") WHERE "clients"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "clients_tenant_idx" ON "clients" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_types_provider_name_idx" ON "document_types" USING btree ("provider_id","name") WHERE "document_types"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "document_types_tenant_idx" ON "document_types" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "document_types_provider_idx" ON "document_types" USING btree ("provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_s3_key_idx" ON "documents" USING btree ("s3_key");--> statement-breakpoint
CREATE INDEX "documents_tenant_created_idx" ON "documents" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "documents_tenant_type_idx" ON "documents" USING btree ("tenant_id","document_type_id");--> statement-breakpoint
CREATE INDEX "documents_client_idx" ON "documents" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "extract_fields_template_root_name_idx" ON "extract_fields" USING btree ("extract_template_id","name") WHERE "extract_fields"."parent_field_id" IS NULL AND "extract_fields"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "extract_fields_template_parent_name_idx" ON "extract_fields" USING btree ("extract_template_id","parent_field_id","name") WHERE "extract_fields"."parent_field_id" IS NOT NULL AND "extract_fields"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "extract_fields_template_order_idx" ON "extract_fields" USING btree ("extract_template_id","sort_order");--> statement-breakpoint
CREATE INDEX "extract_fields_tenant_idx" ON "extract_fields" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "extract_fields_parent_idx" ON "extract_fields" USING btree ("parent_field_id");--> statement-breakpoint
CREATE UNIQUE INDEX "extract_templates_document_type_idx" ON "extract_templates" USING btree ("document_type_id") WHERE "extract_templates"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "extract_templates_tenant_idx" ON "extract_templates" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "extractions_s3_key_calibration_rev_idx" ON "extractions" USING btree ("s3_key","calibration_rev");--> statement-breakpoint
CREATE INDEX "extractions_tenant_created_idx" ON "extractions" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "extractions_document_idx" ON "extractions" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "extractions_template_idx" ON "extractions" USING btree ("extract_template_id");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_template_versions_template_version_idx" ON "outbound_template_versions" USING btree ("outbound_template_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_templates_tenant_name_idx" ON "outbound_templates" USING btree ("tenant_id","name") WHERE "outbound_templates"."tenant_id" IS NOT NULL AND "outbound_templates"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_templates_system_name_idx" ON "outbound_templates" USING btree ("name") WHERE "outbound_templates"."tenant_id" IS NULL AND "outbound_templates"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "outbound_templates_tenant_idx" ON "outbound_templates" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "providers_tenant_name_idx" ON "providers" USING btree ("tenant_id","name") WHERE "providers"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "providers_tenant_idx" ON "providers" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "report_documents_report_role_extraction_idx" ON "report_documents" USING btree ("report_id","role_key","extraction_id");--> statement-breakpoint
CREATE INDEX "report_documents_report_role_idx" ON "report_documents" USING btree ("report_id","role_key","sort_order");--> statement-breakpoint
CREATE INDEX "report_documents_tenant_idx" ON "report_documents" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "report_documents_extraction_idx" ON "report_documents" USING btree ("extraction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "report_jobs_s3_key_idx" ON "report_jobs" USING btree ("s3_key");--> statement-breakpoint
CREATE INDEX "report_jobs_tenant_status_idx" ON "report_jobs" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "report_jobs_tenant_created_idx" ON "report_jobs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "report_jobs_document_idx" ON "report_jobs" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "report_jobs_report_idx" ON "report_jobs" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "reports_tenant_created_idx" ON "reports" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "reports_tenant_client_idx" ON "reports" USING btree ("tenant_id","client_id");--> statement-breakpoint
CREATE INDEX "reports_template_version_idx" ON "reports" USING btree ("template_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_frozen_html_s3_key_idx" ON "reports" USING btree ("frozen_html_s3_key") WHERE "reports"."frozen_html_s3_key" IS NOT NULL;