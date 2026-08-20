DROP INDEX "lov_code_type_language_tenant_idx";--> statement-breakpoint
DROP INDEX "lov_tenant_type_value_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "lov_tenant_type_code_idx" ON "list_of_values" USING btree ("tenant_id","type","code") WHERE "list_of_values"."deleted_at" IS NULL;