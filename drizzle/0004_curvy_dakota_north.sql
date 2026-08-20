CREATE TABLE "questions_and_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar(20) NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"owner" varchar(20) NOT NULL,
	"author" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'open' NOT NULL,
	"answer" text,
	"answered_by" varchar(20),
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "qf_status_idx" ON "questions_and_feedback" USING btree ("status") WHERE "questions_and_feedback"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "qf_owner_idx" ON "questions_and_feedback" USING btree ("owner") WHERE "questions_and_feedback"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "qf_kind_idx" ON "questions_and_feedback" USING btree ("kind") WHERE "questions_and_feedback"."deleted_at" IS NULL;--> statement-breakpoint
INSERT INTO "list_of_values" ("type", "code", "value", "sort_order", "is_active", "is_system") VALUES
  ('qf_kind',   'question', 'Pergunta',   10, true, true),
  ('qf_kind',   'bug',      'Bug',        20, true, true),
  ('qf_kind',   'feedback', 'Feedback',   30, true, true),
  ('qf_status', 'open',     'Aberto',     10, true, true),
  ('qf_status', 'answered', 'Respondido', 20, true, true),
  ('qf_status', 'closed',   'Fechado',    30, true, true),
  ('qf_status', 'wont_fix', 'Não fazer',  40, true, true),
  ('qf_owner',  'po',       'PO',         10, true, true),
  ('qf_owner',  'se',       'SE',         20, true, true),
  ('qf_owner',  'dev',      'Dev',        30, true, true),
  ('qf_owner',  'ai',       'IA',         40, true, true)
ON CONFLICT DO NOTHING;