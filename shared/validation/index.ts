// shared/validation/index.ts
//
// Barrel export for Zod schemas shared between the frontend (forms) and the
// backend (tRPC input validation). One file per domain — both sides import
// from a single source of truth.

export { slugify } from "./slugify";

export { CreateCategoryInput, UpdateCategoryInput } from "./category-schemas";

export {
  CreatePaymentMethodInput,
  UpdatePaymentMethodInput,
  PaymentMethodsListInput,
} from "./payment-method-schemas";

export {
  TenantValueKindZ,
  CreateTenantValueInput,
  UpdateTenantValueInput,
  TenantValuesListInput,
  TenantValuesTransactionsCountInput,
} from "./tenant-value-schemas";

export { CreateTransactionInput, UpdateTransactionInput } from "./transaction-schemas";

export {
  UploadStatementInput,
  ResolveCashBoxInput,
  UpdateErrorRowInput,
  ReviewRowAction,
  ReviewRowInput,
  ListImportRowsInput,
} from "./statement-import-schemas";

export { CreateTenantInput, CreateCustomerInput } from "./onboarding-schemas";
