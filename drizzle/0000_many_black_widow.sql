CREATE TABLE "list_of_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(50) NOT NULL,
	"value" varchar(100) NOT NULL,
	"type" varchar(50) NOT NULL,
	"category" varchar(50),
	"language" varchar(5) DEFAULT 'pt-BR',
	"is_system" boolean DEFAULT true NOT NULL,
	"tenant_id" varchar(64),
	"sort_order" integer DEFAULT 0,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "lov_code_type_language_tenant_idx" ON "list_of_values" USING btree ("code" text_ops,"type" text_ops,"language" text_ops,"tenant_id" text_ops);--> statement-breakpoint
CREATE INDEX "lov_is_active_idx" ON "list_of_values" USING btree ("is_active" bool_ops);--> statement-breakpoint
CREATE INDEX "lov_tenant_id_idx" ON "list_of_values" USING btree ("tenant_id" text_ops);--> statement-breakpoint
CREATE INDEX "lov_type_idx" ON "list_of_values" USING btree ("type" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "users_open_id_tenant_id_idx" ON "users" USING btree ("open_id" text_ops,"tenant_id" text_ops);--> statement-breakpoint
CREATE INDEX "users_tenant_id_idx" ON "users" USING btree ("tenant_id" text_ops);