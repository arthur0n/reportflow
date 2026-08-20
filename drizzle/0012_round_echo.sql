CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
ALTER TABLE "category_templates" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "category_templates" CASCADE;--> statement-breakpoint
DROP INDEX "lov_tenant_type_code_idx";--> statement-breakpoint
ALTER TABLE "list_of_values" ADD COLUMN "category" varchar(50);--> statement-breakpoint
CREATE UNIQUE INDEX "lov_tenant_type_category_code_idx" ON "list_of_values" USING btree ("tenant_id","type","category","code") WHERE "list_of_values"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "lov_type_category_idx" ON "list_of_values" USING btree ("type","category");