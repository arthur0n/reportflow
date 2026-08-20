ALTER TABLE "transaction_recurrences" DROP CONSTRAINT "transaction_recurrences_unit_check";--> statement-breakpoint
ALTER TABLE "transaction_recurrences" DROP CONSTRAINT "transaction_recurrences_interval_count_check";--> statement-breakpoint
ALTER TABLE "transaction_recurrences" ADD COLUMN "recurrence_pattern_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "transaction_recurrences" ADD CONSTRAINT "transaction_recurrences_recurrence_pattern_id_list_of_values_id_fk" FOREIGN KEY ("recurrence_pattern_id") REFERENCES "public"."list_of_values"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transaction_recurrences" DROP COLUMN "interval_count";--> statement-breakpoint
ALTER TABLE "transaction_recurrences" DROP COLUMN "interval_unit";