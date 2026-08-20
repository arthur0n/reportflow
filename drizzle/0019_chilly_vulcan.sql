CREATE TABLE "import_match_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"statement_import_row_id" uuid,
	"target_kind" varchar(30) NOT NULL,
	"lov_target_id" uuid,
	"tv_target_id" uuid,
	"input_raw" text NOT NULL,
	"input_normalized" text NOT NULL,
	"proposed_by_strategy" varchar(40),
	"proposed_confidence" smallint,
	"decision_kind" varchar(20) NOT NULL,
	"overridden_lov_target_id" uuid,
	"overridden_tv_target_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"last_upd_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_upd_by" uuid,
	CONSTRAINT "import_match_decisions_target_xor_check" CHECK (("import_match_decisions"."lov_target_id" IS NOT NULL AND "import_match_decisions"."tv_target_id" IS NULL) OR ("import_match_decisions"."lov_target_id" IS NULL AND "import_match_decisions"."tv_target_id" IS NOT NULL)),
	CONSTRAINT "import_match_decisions_decision_kind_check" CHECK ("import_match_decisions"."decision_kind" IN ('accepted', 'overridden', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "import_match_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"category" varchar(50),
	"target_kind" varchar(30) NOT NULL,
	"match_kind" varchar(20) NOT NULL,
	"pattern" text NOT NULL,
	"lov_target_id" uuid,
	"tv_target_id" uuid,
	"confidence" smallint DEFAULT 85 NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"origin" varchar(20) NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"last_upd_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_upd_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "import_match_rules_target_xor_check" CHECK (("import_match_rules"."lov_target_id" IS NOT NULL AND "import_match_rules"."tv_target_id" IS NULL) OR ("import_match_rules"."lov_target_id" IS NULL AND "import_match_rules"."tv_target_id" IS NOT NULL)),
	CONSTRAINT "import_match_rules_match_kind_check" CHECK ("import_match_rules"."match_kind" IN ('regex', 'contains', 'equals')),
	CONSTRAINT "import_match_rules_origin_check" CHECK ("import_match_rules"."origin" IN ('system_seed', 'admin', 'user_promoted')),
	CONSTRAINT "import_match_rules_system_lov_only_check" CHECK ("import_match_rules"."tenant_id" IS NOT NULL OR "import_match_rules"."tv_target_id" IS NULL),
	CONSTRAINT "import_match_rules_tenant_no_category_check" CHECK ("import_match_rules"."tenant_id" IS NULL OR "import_match_rules"."category" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "statement_import_rows" ADD COLUMN "source_strategy" varchar(40);--> statement-breakpoint
ALTER TABLE "statement_import_rows" ADD COLUMN "match_proposal_json" jsonb;--> statement-breakpoint
ALTER TABLE "import_match_decisions" ADD CONSTRAINT "import_match_decisions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_match_decisions" ADD CONSTRAINT "import_match_decisions_statement_import_row_id_statement_import_rows_id_fk" FOREIGN KEY ("statement_import_row_id") REFERENCES "public"."statement_import_rows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_match_decisions" ADD CONSTRAINT "import_match_decisions_lov_target_id_list_of_values_id_fk" FOREIGN KEY ("lov_target_id") REFERENCES "public"."list_of_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_match_decisions" ADD CONSTRAINT "import_match_decisions_tv_target_id_tenant_values_id_fk" FOREIGN KEY ("tv_target_id") REFERENCES "public"."tenant_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_match_decisions" ADD CONSTRAINT "import_match_decisions_overridden_lov_target_id_list_of_values_id_fk" FOREIGN KEY ("overridden_lov_target_id") REFERENCES "public"."list_of_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_match_decisions" ADD CONSTRAINT "import_match_decisions_overridden_tv_target_id_tenant_values_id_fk" FOREIGN KEY ("overridden_tv_target_id") REFERENCES "public"."tenant_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_match_rules" ADD CONSTRAINT "import_match_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_match_rules" ADD CONSTRAINT "import_match_rules_lov_target_id_list_of_values_id_fk" FOREIGN KEY ("lov_target_id") REFERENCES "public"."list_of_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_match_rules" ADD CONSTRAINT "import_match_rules_tv_target_id_tenant_values_id_fk" FOREIGN KEY ("tv_target_id") REFERENCES "public"."tenant_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_match_decisions_lookup_idx" ON "import_match_decisions" USING btree ("tenant_id","target_kind","input_normalized");--> statement-breakpoint
CREATE INDEX "import_match_decisions_strategy_idx" ON "import_match_decisions" USING btree ("tenant_id","proposed_by_strategy","decision_kind");--> statement-breakpoint
CREATE INDEX "import_match_decisions_row_idx" ON "import_match_decisions" USING btree ("statement_import_row_id");--> statement-breakpoint
CREATE INDEX "import_match_rules_tenant_idx" ON "import_match_rules" USING btree ("tenant_id","target_kind","priority") WHERE "import_match_rules"."deleted_at" IS NULL AND "import_match_rules"."tenant_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "import_match_rules_system_idx" ON "import_match_rules" USING btree ("target_kind","priority") WHERE "import_match_rules"."deleted_at" IS NULL AND "import_match_rules"."tenant_id" IS NULL;