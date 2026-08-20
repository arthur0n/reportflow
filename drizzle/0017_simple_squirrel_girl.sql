ALTER TABLE "business_units" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "business_units" CASCADE;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_business_unit_id_tenant_values_id_fk" FOREIGN KEY ("business_unit_id") REFERENCES "public"."tenant_values"("id") ON DELETE no action ON UPDATE no action;