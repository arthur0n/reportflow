// shared/validation/index.ts
//
// Barrel export for Zod schemas shared between the frontend (forms) and the
// backend (tRPC input validation). One file per domain — both sides import
// from a single source of truth.

export { slugify } from "./slugify";

export {
  TenantValueKindZ,
  CreateTenantValueInput,
  UpdateTenantValueInput,
  TenantValuesListInput,
} from "./tenant-value-schemas";

export { CreateTenantInput, CreateCustomerInput } from "./onboarding-schemas";
