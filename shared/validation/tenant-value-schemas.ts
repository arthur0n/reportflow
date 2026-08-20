// shared/validation/tenant-value-schemas.ts
//
// Zod input schemas for the generic tenantValues router. The discriminator
// `kind` matches the TENANT_VALUE_KINDS constant; per-kind behavior lives in
// shared/constants/tenant-value-kinds.ts.
//
// Parent disambiguation: tenant-LOV parents (e.g. CATEGORY) come in as
// `parentLov` (uuid). System-LOV parents (e.g. CASH_BOX_TYPE) come in as
// `parentLovCode` (string code); the router resolves to id. The router uses
// the kind's config to pick which field to read; the other is ignored.

import { z } from "zod/v4";
import { TENANT_VALUE_KINDS } from "../constants/tenant-value-kinds";

export const TenantValueKindZ = z.enum(TENANT_VALUE_KINDS);
export type TenantValueKindT = z.infer<typeof TenantValueKindZ>;

export const TenantValuesListInput = z.object({
  kind: TenantValueKindZ,
  status: z.enum(["active", "inactive", "all"]).default("active"),
  parentLov: z.string().uuid().optional(),
  hasParent: z.boolean().optional(),
  search: z.string().trim().max(100).optional(),
});

export const CreateTenantValueInput = z.object({
  kind: TenantValueKindZ,
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).nullable().optional(),
  parentLov: z.string().uuid().nullable().optional(),
  parentLovCode: z.string().trim().min(1).max(50).optional(),
  // CASH_BOX with parent code='bank' requires this; the router enforces.
  bankSlugId: z.string().uuid().nullable().optional(),
  // Set after the user has seen similarity suggestions and chose to create
  // a new row anyway. Default false → server runs the preflight.
  confirmedDespiteSuggestions: z.boolean().optional(),
});

export const UpdateTenantValueInput = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  parentLov: z.string().uuid().nullable().optional(),
  parentLovCode: z.string().trim().min(1).max(50).optional(),
  bankSlugId: z.string().uuid().nullable().optional(),
});

export const TenantValuesTransactionsCountInput = z.object({
  kind: TenantValueKindZ,
  ids: z.array(z.string().uuid()).min(1).max(200),
});

export type CreateTenantValueInputT = z.infer<typeof CreateTenantValueInput>;
export type UpdateTenantValueInputT = z.infer<typeof UpdateTenantValueInput>;
export type TenantValuesListInputT = z.infer<typeof TenantValuesListInput>;
