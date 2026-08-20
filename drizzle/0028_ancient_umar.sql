ALTER TABLE "statement_imports" ADD COLUMN "source_kind" text DEFAULT 'bank' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "mode" varchar(16) DEFAULT 'full' NOT NULL;--> statement-breakpoint
ALTER TABLE "statement_imports" ADD CONSTRAINT "statement_imports_source_kind_check" CHECK ("statement_imports"."source_kind" IN ('bank', 'card'));--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_mode_check" CHECK ("tenants"."mode" IN ('full', 'import_only'));