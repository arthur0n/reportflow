CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"entity_type" varchar(40) NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" varchar(40) NOT NULL,
	"field_name" text,
	"old_value" text,
	"new_value" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"last_upd_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_upd_by" uuid NOT NULL,
	CONSTRAINT "audit_logs_action_check" CHECK ("audit_logs"."action" IN (
        'create', 'update', 'delete', 'restore', 'reclassify', 'promote_to_system'
      ))
);
--> statement-breakpoint
CREATE TABLE "list_of_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" varchar(50) NOT NULL,
	"code" varchar(50) NOT NULL,
	"value" varchar(100) NOT NULL,
	"description" text,
	"parent_lov" uuid,
	"tenant_id" varchar(64),
	"category" varchar(50),
	"language" varchar(5) DEFAULT 'pt-BR',
	"sort_order" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"last_upd_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_upd_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "tenant_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"kind" varchar(50) NOT NULL,
	"code" varchar(50) NOT NULL,
	"value" varchar(100) NOT NULL,
	"description" text,
	"parent_lov" uuid,
	"bank_slug_id" uuid,
	"language" varchar(5) DEFAULT 'pt-BR',
	"sort_order" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"last_upd_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_upd_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"open_id" varchar(64) NOT NULL,
	"tenant_id" varchar(64) NOT NULL,
	"email" varchar(320),
	"name" text,
	"role" varchar(20) DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"last_upd_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_upd_by" uuid,
	CONSTRAINT "users_role_check" CHECK ("users"."role" IN ('platform_admin', 'admin', 'member'))
);
--> statement-breakpoint
ALTER TABLE "list_of_values" ADD CONSTRAINT "list_of_values_parent_lov_list_of_values_id_fk" FOREIGN KEY ("parent_lov") REFERENCES "public"."list_of_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_values" ADD CONSTRAINT "tenant_values_parent_lov_list_of_values_id_fk" FOREIGN KEY ("parent_lov") REFERENCES "public"."list_of_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_values" ADD CONSTRAINT "tenant_values_bank_slug_id_list_of_values_id_fk" FOREIGN KEY ("bank_slug_id") REFERENCES "public"."list_of_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("tenant_id","entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_created_idx" ON "audit_logs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "lov_tenant_type_category_code_idx" ON "list_of_values" USING btree ("tenant_id","type","category","code") WHERE "list_of_values"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "lov_type_idx" ON "list_of_values" USING btree ("type");--> statement-breakpoint
CREATE INDEX "lov_tenant_type_idx" ON "list_of_values" USING btree ("tenant_id","type");--> statement-breakpoint
CREATE INDEX "lov_type_category_idx" ON "list_of_values" USING btree ("type","category");--> statement-breakpoint
CREATE INDEX "lov_parent_lov_idx" ON "list_of_values" USING btree ("parent_lov");--> statement-breakpoint
CREATE INDEX "lov_type_parent_idx" ON "list_of_values" USING btree ("type","parent_lov");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_values_tenant_kind_code_idx" ON "tenant_values" USING btree ("tenant_id","kind","code") WHERE "tenant_values"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "tenant_values_tenant_kind_idx" ON "tenant_values" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE INDEX "tenant_values_parent_lov_idx" ON "tenant_values" USING btree ("parent_lov");--> statement-breakpoint
CREATE UNIQUE INDEX "users_open_id_tenant_id_idx" ON "users" USING btree ("open_id","tenant_id");--> statement-breakpoint
CREATE INDEX "users_tenant_idx" ON "users" USING btree ("tenant_id");