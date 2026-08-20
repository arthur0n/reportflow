ALTER TABLE "statement_import_rows" RENAME COLUMN "transaction_type" TO "subtype_br";--> statement-breakpoint
ALTER TABLE "statement_imports" RENAME COLUMN "updated_at" TO "last_upd_at";--> statement-breakpoint
DROP INDEX "statement_imports_tenant_file_hash_idx";--> statement-breakpoint
DROP INDEX "statement_imports_tenant_status_updated_idx";--> statement-breakpoint
ALTER TABLE "statement_import_events" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "statement_import_events" ADD COLUMN "last_upd_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "statement_import_events" ADD COLUMN "last_upd_by" uuid;--> statement-breakpoint
ALTER TABLE "statement_import_rows" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "statement_import_rows" ADD COLUMN "last_upd_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "statement_import_rows" ADD COLUMN "last_upd_by" uuid;--> statement-breakpoint
ALTER TABLE "statement_imports" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "statement_imports" ADD COLUMN "last_upd_by" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "statement_imports_tenant_file_hash_idx" ON "statement_imports" USING btree ("tenant_id","file_hash") WHERE "statement_imports"."status" NOT IN ('approved', 'rejected', 'upload_timeout');--> statement-breakpoint
CREATE INDEX "statement_imports_tenant_status_updated_idx" ON "statement_imports" USING btree ("tenant_id","status","last_upd_at");--> statement-breakpoint
ALTER TABLE "statement_imports" DROP COLUMN "purged_at";