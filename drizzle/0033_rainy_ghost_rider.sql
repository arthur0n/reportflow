DROP INDEX "acquirer_sales_grain_idx";--> statement-breakpoint
ALTER TABLE "acquirer_sales" ADD COLUMN "sale_time" text;--> statement-breakpoint
ALTER TABLE "acquirer_sales" ADD COLUMN "brand" text;--> statement-breakpoint
ALTER TABLE "acquirer_sales" ADD COLUMN "expected_payment_date" date NOT NULL;--> statement-breakpoint
ALTER TABLE "acquirer_sales" ADD COLUMN "nsu" text;--> statement-breakpoint
ALTER TABLE "acquirer_sales" ADD COLUMN "sale_code" text NOT NULL;--> statement-breakpoint
ALTER TABLE "acquirer_sales" ADD COLUMN "tx_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "acquirer_sales_sale_code_idx" ON "acquirer_sales" USING btree ("tenant_id","acquirer_id","sale_code") WHERE "acquirer_sales"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "acquirer_sales_prevista_idx" ON "acquirer_sales" USING btree ("tenant_id","expected_payment_date");