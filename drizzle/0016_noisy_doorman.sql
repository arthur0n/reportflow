ALTER TABLE "statement_import_rows" ADD COLUMN "category_id" uuid;--> statement-breakpoint
ALTER TABLE "statement_import_rows" ADD COLUMN "creditor_id" uuid;--> statement-breakpoint
ALTER TABLE "statement_import_rows" ADD COLUMN "payment_method_id" uuid;--> statement-breakpoint
ALTER TABLE "statement_import_rows" ADD CONSTRAINT "statement_import_rows_category_id_list_of_values_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."list_of_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_import_rows" ADD CONSTRAINT "statement_import_rows_creditor_id_tenant_values_id_fk" FOREIGN KEY ("creditor_id") REFERENCES "public"."tenant_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "statement_import_rows" ADD CONSTRAINT "statement_import_rows_payment_method_id_list_of_values_id_fk" FOREIGN KEY ("payment_method_id") REFERENCES "public"."list_of_values"("id") ON DELETE no action ON UPDATE no action;