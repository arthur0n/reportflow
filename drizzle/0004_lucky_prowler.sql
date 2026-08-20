CREATE UNIQUE INDEX "report_jobs_pending_extract_idx" ON "report_jobs" USING btree ("tenant_id","document_id") WHERE "report_jobs"."status" = 'pending' AND "report_jobs"."kind" = 'extract';
