ALTER TABLE "transactions" ALTER COLUMN "interest_amount" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "transactions" drop column "interest_amount";--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "interest_amount" bigint GENERATED ALWAYS AS (COALESCE(actual_amount, 0::bigint) - forecast_amount) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD COLUMN "business_unit_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_business_unit_id_business_units_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."business_units"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_accounts_business_unit_idx" ON "bank_accounts" USING btree ("business_unit_id");--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_status_check" CHECK ("transactions"."status" IN ('CERTO', 'ESTIMADO', 'META', 'INATIVO', 'REVISAR', 'FANEC'));