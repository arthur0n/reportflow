CREATE TABLE "tenant_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" varchar(50) NOT NULL,
	"code" varchar(50) NOT NULL,
	"value" varchar(100) NOT NULL,
	"description" text,
	"parent_lov" uuid,
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
ALTER TABLE "statement_imports" DROP CONSTRAINT "statement_imports_cash_box_id_list_of_values_id_fk";
--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_creditor_id_list_of_values_id_fk";
--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_cash_box_id_list_of_values_id_fk";
--> statement-breakpoint
ALTER TABLE "tenant_values" ADD CONSTRAINT "tenant_values_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_values" ADD CONSTRAINT "tenant_values_parent_lov_list_of_values_id_fk" FOREIGN KEY ("parent_lov") REFERENCES "public"."list_of_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_values_tenant_kind_code_idx" ON "tenant_values" USING btree ("tenant_id","kind","code") WHERE "tenant_values"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "tenant_values_tenant_kind_idx" ON "tenant_values" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE INDEX "tenant_values_parent_lov_idx" ON "tenant_values" USING btree ("parent_lov");--> statement-breakpoint
ALTER TABLE "statement_imports" ADD CONSTRAINT "statement_imports_cash_box_id_tenant_values_id_fk" FOREIGN KEY ("cash_box_id") REFERENCES "public"."tenant_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_creditor_id_tenant_values_id_fk" FOREIGN KEY ("creditor_id") REFERENCES "public"."tenant_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_cash_box_id_tenant_values_id_fk" FOREIGN KEY ("cash_box_id") REFERENCES "public"."tenant_values"("id") ON DELETE no action ON UPDATE no action;