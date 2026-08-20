// Zod inputs for the import_match_rules CRUD router.
//
// Two surfaces — tenant (admin) and system (superadmin):
//   - Tenant rules: tenant_id from ctx.tenantId; only target tenant or
//     system LOV rows / tenant_values; `category` MUST be null.
//   - System rules: tenant_id NULL; can only target system LOV rows; the
//     `category` column scopes audience by tenants.industry.
//
// Regex compile-test happens at the router; this file only validates shape.

import { z } from "zod/v4";

export const RuleTargetKind = z.enum([
  "CATEGORY",
  "PAYMENT_METHOD",
  "SUPPLIER",
  "CUSTOMER",
  "SUBTYPE",
]);

export const RuleMatchKind = z.enum(["regex", "contains", "equals"]);

// Exactly one of lovTargetId / tvTargetId is set; the router enforces the
// pairing against targetKind (CATEGORY/PAYMENT_METHOD → lov; SUPPLIER/CUSTOMER → tv).
const RuleTarget = z.object({
  lovTargetId: z.string().uuid().nullable().optional(),
  tvTargetId: z.string().uuid().nullable().optional(),
});

const RuleBody = z.object({
  targetKind: RuleTargetKind,
  matchKind: RuleMatchKind,
  pattern: z.string().trim().min(1).max(500),
  confidence: z.number().int().min(0).max(100).optional(),
  priority: z.number().int().min(0).max(10000).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
});

// ──────────────────── Tenant (admin) ────────────────────

export const ListTenantRulesInput = z.object({
  targetKind: RuleTargetKind.optional(),
  status: z.enum(["active", "inactive", "all"]).optional().default("active"),
});

export const CreateTenantRuleInput = RuleBody.extend(RuleTarget.shape);

export const UpdateTenantRuleInput = z.object({
  id: z.string().uuid(),
  matchKind: RuleMatchKind.optional(),
  pattern: z.string().trim().min(1).max(500).optional(),
  confidence: z.number().int().min(0).max(100).optional(),
  priority: z.number().int().min(0).max(10000).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
});

// ──────────────────── System (superadmin) ────────────────────

export const ListSystemRulesInput = z.object({
  targetKind: RuleTargetKind.optional(),
  category: z.string().trim().min(1).max(50).nullable().optional(),
  status: z.enum(["active", "inactive", "all"]).optional().default("active"),
});

export const CreateSystemRuleInput = RuleBody.extend({
  // System rules can only target system LOV rows; the router rejects tvTargetId.
  lovTargetId: z.string().uuid(),
  // Audience scope; null = applies to every tenant industry.
  category: z.string().trim().min(1).max(50).nullable().optional(),
});

export const UpdateSystemRuleInput = z.object({
  id: z.string().uuid(),
  matchKind: RuleMatchKind.optional(),
  pattern: z.string().trim().min(1).max(500).optional(),
  confidence: z.number().int().min(0).max(100).optional(),
  priority: z.number().int().min(0).max(10000).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  category: z.string().trim().min(1).max(50).nullable().optional(),
});
