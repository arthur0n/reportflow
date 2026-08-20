// shared/constants/tenant-value-kinds.ts
//
// Per-kind behavior config for tenant_values rows. The TENANT_VALUES LOV
// registry supplies the user-facing plural label and description; this config
// supplies the rest: which LOV the parent points at, whether parent is
// required, whether it locks after first transaction, the singular form, and
// which transactions column references rows of this kind.
//
// Adding a new kind: insert a row into the TENANT_VALUES LOV registry
// (scripts/seed.ts) AND a config entry here. The router and UI dispatch off
// this map; nothing else needs touching.

export const TENANT_VALUE_KINDS = ["SUPPLIER", "CUSTOMER", "CASH_BOX", "BUSINESS_UNIT"] as const;
export type TenantValueKind = (typeof TENANT_VALUE_KINDS)[number];

export type ParentRule =
  | { source: "none" }
  | { source: "lov-system"; lovType: string; required: boolean }
  | { source: "lov-tenant"; lovType: string; required: boolean };

export type TenantValueKindConfig = {
  kind: TenantValueKind;
  parent: ParentRule;
  /** True if parent_lov can no longer change once any transaction references this row (RN-7 for CASH_BOX). */
  parentLockedAfterUse: boolean;
  /** pt-BR singular noun used for "Novo X" buttons; plural comes from the TENANT_VALUES LOV row. */
  labelOne: string;
  /** pt-BR label for the parent field/column (e.g. "Categoria padrão", "Tipo"). null when parent.source === "none". */
  parentLabel: string | null;
  /** English kebab-case slug used in URLs (`/parameters/tenant-values/<urlSlug>`). Routes are English code identifiers, not display text. */
  urlSlug: string;
  /** Whether the create/edit form shows the description field. */
  showDescription: boolean;
  /** Which transactions column FKs to this kind (drives transactionsCount and the lock check). null = no transactions reference. */
  txColumn: "creditorId" | "cashBoxId" | "businessUnitId" | null;
};

export const TENANT_VALUE_KIND_CONFIG: Record<TenantValueKind, TenantValueKindConfig> = {
  SUPPLIER: {
    kind: "SUPPLIER",
    parent: { source: "lov-tenant", lovType: "CATEGORY", required: false },
    parentLockedAfterUse: false,
    labelOne: "Fornecedor",
    parentLabel: "Categoria padrão",
    urlSlug: "supplier",
    showDescription: true,
    txColumn: "creditorId",
  },
  CUSTOMER: {
    kind: "CUSTOMER",
    parent: { source: "lov-tenant", lovType: "CATEGORY", required: false },
    parentLockedAfterUse: false,
    labelOne: "Cliente",
    parentLabel: "Categoria padrão",
    urlSlug: "customer",
    showDescription: true,
    txColumn: "creditorId",
  },
  CASH_BOX: {
    kind: "CASH_BOX",
    parent: { source: "lov-system", lovType: "CASH_BOX_TYPE", required: true },
    parentLockedAfterUse: true,
    labelOne: "Caixa",
    parentLabel: "Tipo",
    urlSlug: "cash-box",
    showDescription: false,
    txColumn: "cashBoxId",
  },
  BUSINESS_UNIT: {
    kind: "BUSINESS_UNIT",
    parent: { source: "lov-system", lovType: "BUSINESS_UNIT_TYPE", required: true },
    parentLockedAfterUse: false,
    labelOne: "Unidade",
    parentLabel: "Tipo",
    urlSlug: "business-unit",
    showDescription: true,
    txColumn: "businessUnitId",
  },
};

export function isTenantValueKind(value: string): value is TenantValueKind {
  return (TENANT_VALUE_KINDS as readonly string[]).includes(value);
}

export function kindFromUrlSlug(slug: string): TenantValueKind | null {
  for (const kind of TENANT_VALUE_KINDS) {
    if (TENANT_VALUE_KIND_CONFIG[kind].urlSlug === slug) return kind;
  }
  return null;
}
