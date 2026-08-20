CREATE TABLE "acquirer_sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"acquirer_id" uuid NOT NULL,
	"statement_import_id" uuid NOT NULL,
	"sale_date" date NOT NULL,
	"method" text NOT NULL,
	"gross_amount" bigint NOT NULL,
	"fee_amount" bigint NOT NULL,
	"net_amount" bigint NOT NULL,
	"matched_transaction_id" uuid,
	"matched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"last_upd_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_upd_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
ALTER TABLE "statement_imports" ADD COLUMN "acquirer_id" uuid;--> statement-breakpoint
ALTER TABLE "acquirer_sales" ADD CONSTRAINT "acquirer_sales_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquirer_sales" ADD CONSTRAINT "acquirer_sales_acquirer_id_list_of_values_id_fk" FOREIGN KEY ("acquirer_id") REFERENCES "public"."list_of_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquirer_sales" ADD CONSTRAINT "acquirer_sales_statement_import_id_statement_imports_id_fk" FOREIGN KEY ("statement_import_id") REFERENCES "public"."statement_imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquirer_sales" ADD CONSTRAINT "acquirer_sales_matched_transaction_id_transactions_id_fk" FOREIGN KEY ("matched_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "acquirer_sales_grain_idx" ON "acquirer_sales" USING btree ("tenant_id","acquirer_id","sale_date","method") WHERE "acquirer_sales"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "acquirer_sales_matched_idx" ON "acquirer_sales" USING btree ("tenant_id","matched_transaction_id");--> statement-breakpoint
CREATE INDEX "acquirer_sales_date_idx" ON "acquirer_sales" USING btree ("tenant_id","acquirer_id","sale_date");--> statement-breakpoint
ALTER TABLE "statement_imports" ADD CONSTRAINT "statement_imports_acquirer_id_list_of_values_id_fk" FOREIGN KEY ("acquirer_id") REFERENCES "public"."list_of_values"("id") ON DELETE no action ON UPDATE no action;