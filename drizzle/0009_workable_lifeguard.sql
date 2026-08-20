ALTER TABLE "transactions" DROP CONSTRAINT "transactions_creditor_id_creditors_id_fk";--> statement-breakpoint
UPDATE "transactions" SET "creditor_id" = NULL WHERE "creditor_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "creditors" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "creditors" CASCADE;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_creditor_id_list_of_values_id_fk" FOREIGN KEY ("creditor_id") REFERENCES "public"."list_of_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
COMMENT ON COLUMN "transactions"."creditor_id" IS 'LOV: list_of_values.id where type IN (''SUPPLIER'',''CUSTOMER'') (per-tenant)';
