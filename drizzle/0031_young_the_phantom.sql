ALTER TABLE "audit_logs" DROP CONSTRAINT "audit_logs_action_check";--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_action_check" CHECK ("audit_logs"."action" IN (
        'create', 'update', 'delete', 'restore', 'reclassify', 'promote_to_system',
        'match', 'unmatch',
        'TENANT_SWITCH', 'MEMBERSHIP_INVITE', 'MEMBERSHIP_ACCEPT',
        'MEMBERSHIP_REVOKE', 'MEMBERSHIP_ROLE_CHANGE'
      ));