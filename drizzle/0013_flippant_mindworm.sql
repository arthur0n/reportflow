ALTER TABLE "transactions" RENAME COLUMN "updated_at" TO "last_upd_at";--> statement-breakpoint
ALTER TABLE "transactions" RENAME COLUMN "updated_by" TO "last_upd_by";--> statement-breakpoint
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_status_check";--> statement-breakpoint
ALTER TABLE "transactions" DROP COLUMN "deletion_reason";--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_status_check" CHECK ("transactions"."status" IN ('CERTO', 'ESTIMADO', 'META', 'REVISAR', 'FANEC'));