CREATE TABLE "acquirer_sale_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sale_id" uuid NOT NULL,
	"statement_row_id" uuid NOT NULL,
	"rule" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"last_upd_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_upd_by" uuid
);
--> statement-breakpoint
ALTER TABLE "acquirer_sales" DROP CONSTRAINT "acquirer_sales_matched_statement_row_id_statement_import_rows_id_fk";
--> statement-breakpoint
DROP INDEX "acquirer_sales_matched_idx";--> statement-breakpoint
ALTER TABLE "statement_imports" ADD COLUMN "merchant_tax_id" varchar(18);--> statement-breakpoint
ALTER TABLE "acquirer_sale_settlements" ADD CONSTRAINT "acquirer_sale_settlements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquirer_sale_settlements" ADD CONSTRAINT "acquirer_sale_settlements_sale_id_acquirer_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."acquirer_sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquirer_sale_settlements" ADD CONSTRAINT "acquirer_sale_settlements_statement_row_id_statement_import_rows_id_fk" FOREIGN KEY ("statement_row_id") REFERENCES "public"."statement_import_rows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "acquirer_sale_settlements_pair_idx" ON "acquirer_sale_settlements" USING btree ("sale_id","statement_row_id");--> statement-breakpoint
CREATE INDEX "acquirer_sale_settlements_row_idx" ON "acquirer_sale_settlements" USING btree ("tenant_id","statement_row_id");--> statement-breakpoint
CREATE INDEX "acquirer_sale_settlements_sale_idx" ON "acquirer_sale_settlements" USING btree ("tenant_id","sale_id");--> statement-breakpoint
ALTER TABLE "acquirer_sales" DROP COLUMN "matched_statement_row_id";--> statement-breakpoint
ALTER TABLE "acquirer_sales" DROP COLUMN "matched_at";