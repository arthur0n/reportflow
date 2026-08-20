-- Swap statement_import_rows.subtype_br (varchar text) for subtype_id (uuid FK
-- to list_of_values). subtype is repurposed: previously it held bank-rail
-- inferences (PIX/TED/BOLETO) which now live as PAYMENT_METHOD; the new
-- semantic is fiscal/operational tag (TARIFA, IOF, RENDIMENTO, ...). Pre-MVP
-- greenfield — existing values are dropped, not migrated.

ALTER TABLE "statement_import_rows" DROP COLUMN IF EXISTS "subtype_br";--> statement-breakpoint
ALTER TABLE "statement_import_rows" ADD COLUMN "subtype_id" uuid;--> statement-breakpoint
ALTER TABLE "statement_import_rows" ADD CONSTRAINT "statement_import_rows_subtype_id_list_of_values_id_fk" FOREIGN KEY ("subtype_id") REFERENCES "public"."list_of_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- Drop the obsolete TRANSACTION_SUBTYPE_BR LOV catalog. New TRANSACTION_SUBTYPE
-- rows are inserted by scripts/seed.ts.
DELETE FROM "list_of_values" WHERE "type" = 'TRANSACTION_SUBTYPE_BR';
