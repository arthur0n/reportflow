ALTER TABLE "bank_accounts" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_methods" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "transaction_types" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "bank_accounts" CASCADE;--> statement-breakpoint
DROP TABLE "payment_methods" CASCADE;--> statement-breakpoint
DROP TABLE "transaction_types" CASCADE;--> statement-breakpoint
ALTER TABLE "statement_imports" DROP CONSTRAINT IF EXISTS "statement_imports_bank_account_id_bank_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_transaction_type_transaction_types_code_fk";
--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_payment_method_id_payment_methods_id_fk";
--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT IF EXISTS "transactions_bank_account_id_bank_accounts_id_fk";
--> statement-breakpoint
ALTER TABLE "statement_imports" ADD COLUMN "cash_box_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "cash_box_id" uuid;--> statement-breakpoint
ALTER TABLE "statement_imports" ADD CONSTRAINT "statement_imports_cash_box_id_list_of_values_id_fk" FOREIGN KEY ("cash_box_id") REFERENCES "public"."list_of_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_payment_method_id_list_of_values_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."list_of_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_cash_box_id_list_of_values_id_fk" FOREIGN KEY ("cash_box_id") REFERENCES "public"."list_of_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_imports" DROP COLUMN IF EXISTS "bank_account_id";--> statement-breakpoint
ALTER TABLE "transactions" DROP COLUMN IF EXISTS "bank_account_id";