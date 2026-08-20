-- Greenfield: drop legacy varchar transaction_type / status / installment_ref
-- columns and add the FK / wider replacements. Truncate first so NOT NULL adds
-- don't fail; statement_import_rows.matched_transaction_id and the import
-- lifecycle tables go with it via CASCADE.
TRUNCATE TABLE "transactions", "statement_imports", "statement_import_rows", "statement_import_events" RESTART IDENTITY CASCADE;--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_status_check";--> statement-breakpoint
DROP INDEX "transactions_tenant_status_idx";--> statement-breakpoint
ALTER TABLE "transactions" DROP COLUMN "transaction_type";--> statement-breakpoint
ALTER TABLE "transactions" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "transactions" DROP COLUMN "installment_ref";--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "transaction_type_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "status_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "subtype_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "reference" varchar(80);--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_transaction_type_id_list_of_values_id_fk" FOREIGN KEY ("transaction_type_id") REFERENCES "public"."list_of_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_subtype_id_list_of_values_id_fk" FOREIGN KEY ("subtype_id") REFERENCES "public"."list_of_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_status_id_list_of_values_id_fk" FOREIGN KEY ("status_id") REFERENCES "public"."list_of_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transactions_tenant_status_idx" ON "transactions" USING btree ("tenant_id","status_id") WHERE "transactions"."deleted_at" IS NULL;
