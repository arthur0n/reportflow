CREATE TABLE "statement_import_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"statement_import_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"actor_user_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "statement_import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"statement_import_id" uuid NOT NULL,
	"line_number" integer NOT NULL,
	"status" text NOT NULL,
	"raw_payload" jsonb,
	"actual_date" date,
	"actual_amount" bigint,
	"description" text,
	"transaction_type" varchar(30),
	"external_id" text,
	"matched_transaction_id" uuid,
	"match_confidence" smallint,
	"error_detail" text,
	"edited_at" timestamp with time zone,
	"edited_by" uuid,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "statement_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"upload_batch_id" uuid,
	"bank_account_id" uuid,
	"file_name" text NOT NULL,
	"file_size" integer NOT NULL,
	"file_hash" text NOT NULL,
	"s3_key" text,
	"source_format" text,
	"bank_slug" text,
	"account_ref" text,
	"period_start" date,
	"period_end" date,
	"status" text DEFAULT 'uploaded_pending' NOT NULL,
	"rows_total" integer DEFAULT 0 NOT NULL,
	"rows_error" integer DEFAULT 0 NOT NULL,
	"error_message" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"parsed_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "business_unit_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "bank_slug" varchar(30);--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "account_ref" varchar(60);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "statement_import_id" uuid;--> statement-breakpoint
ALTER TABLE "statement_import_events" ADD CONSTRAINT "statement_import_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_import_events" ADD CONSTRAINT "statement_import_events_statement_import_id_statement_imports_id_fk" FOREIGN KEY ("statement_import_id") REFERENCES "public"."statement_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_import_rows" ADD CONSTRAINT "statement_import_rows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_import_rows" ADD CONSTRAINT "statement_import_rows_statement_import_id_statement_imports_id_fk" FOREIGN KEY ("statement_import_id") REFERENCES "public"."statement_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_import_rows" ADD CONSTRAINT "statement_import_rows_matched_transaction_id_transactions_id_fk" FOREIGN KEY ("matched_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_imports" ADD CONSTRAINT "statement_imports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_imports" ADD CONSTRAINT "statement_imports_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_imports" ADD CONSTRAINT "statement_imports_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "statement_import_events_import_idx" ON "statement_import_events" USING btree ("statement_import_id");--> statement-breakpoint
CREATE INDEX "statement_import_rows_import_line_idx" ON "statement_import_rows" USING btree ("statement_import_id","line_number");--> statement-breakpoint
CREATE INDEX "statement_import_rows_matched_txn_idx" ON "statement_import_rows" USING btree ("matched_transaction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "statement_imports_tenant_file_hash_idx" ON "statement_imports" USING btree ("tenant_id","file_hash") WHERE "statement_imports"."status" NOT IN ('approved', 'rejected', 'purged', 'upload_timeout');--> statement-breakpoint
CREATE INDEX "statement_imports_tenant_status_updated_idx" ON "statement_imports" USING btree ("tenant_id","status","updated_at");--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_statement_import_id_statement_imports_id_fk" FOREIGN KEY ("statement_import_id") REFERENCES "public"."statement_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_tenant_bank_slug_account_ref_idx" ON "bank_accounts" USING btree ("tenant_id","bank_slug","account_ref") WHERE "bank_accounts"."bank_slug" IS NOT NULL AND "bank_accounts"."account_ref" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_tenant_external_id_idx" ON "transactions" USING btree ("tenant_id","external_id") WHERE "transactions"."external_id" IS NOT NULL;