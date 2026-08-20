DROP INDEX "acquirer_sales_sale_code_idx";--> statement-breakpoint
DROP INDEX "acquirer_sales_date_idx";--> statement-breakpoint
ALTER TABLE "acquirer_sales" ADD COLUMN "merchant_account" text NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "acquirer_sales_sale_code_idx" ON "acquirer_sales" USING btree ("tenant_id","acquirer_id","merchant_account","sale_code") WHERE "acquirer_sales"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "acquirer_sales_date_idx" ON "acquirer_sales" USING btree ("tenant_id","sale_date");