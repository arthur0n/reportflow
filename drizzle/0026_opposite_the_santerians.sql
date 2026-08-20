CREATE TABLE "transaction_recurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"mode" varchar(16) NOT NULL,
	"interval_count" integer NOT NULL,
	"interval_unit" varchar(8) NOT NULL,
	"repeat_count" integer,
	"start_date" date NOT NULL,
	"generated_until" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"last_upd_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_upd_by" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "transaction_recurrences_mode_check" CHECK ("transaction_recurrences"."mode" IN ('finite','always')),
	CONSTRAINT "transaction_recurrences_unit_check" CHECK ("transaction_recurrences"."interval_unit" IN ('day','week','month')),
	CONSTRAINT "transaction_recurrences_interval_count_check" CHECK ("transaction_recurrences"."interval_count" > 0),
	CONSTRAINT "transaction_recurrences_finite_has_count_check" CHECK ("transaction_recurrences"."mode" <> 'finite' OR "transaction_recurrences"."repeat_count" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "recurrence_id" uuid;--> statement-breakpoint
ALTER TABLE "transaction_recurrences" ADD CONSTRAINT "transaction_recurrences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transaction_recurrences_tenant_idx" ON "transaction_recurrences" USING btree ("tenant_id") WHERE "transaction_recurrences"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_recurrence_id_transaction_recurrences_id_fk" FOREIGN KEY ("recurrence_id") REFERENCES "public"."transaction_recurrences"("id") ON DELETE no action ON UPDATE no action;