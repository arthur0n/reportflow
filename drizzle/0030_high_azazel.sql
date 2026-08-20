ALTER TABLE "acquirer_sales" DROP CONSTRAINT "acquirer_sales_matched_transaction_id_transactions_id_fk";
--> statement-breakpoint
DROP INDEX "acquirer_sales_matched_idx";--> statement-breakpoint
ALTER TABLE "acquirer_sales" ADD COLUMN "matched_statement_row_id" uuid;--> statement-breakpoint
ALTER TABLE "acquirer_sales" ADD CONSTRAINT "acquirer_sales_matched_statement_row_id_statement_import_rows_id_fk" FOREIGN KEY ("matched_statement_row_id") REFERENCES "public"."statement_import_rows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acquirer_sales_matched_idx" ON "acquirer_sales" USING btree ("tenant_id","matched_statement_row_id");--> statement-breakpoint
ALTER TABLE "acquirer_sales" DROP COLUMN "matched_transaction_id";