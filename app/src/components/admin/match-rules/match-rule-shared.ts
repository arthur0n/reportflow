// Shared constants + types for admin import_match_rules pages.
// Tenant and system pages use the same target/match enums and dialog shape;
// keeping them here lets both pages stay under the function/file size caps.

export type TargetKind = "CATEGORY" | "PAYMENT_METHOD" | "SUPPLIER" | "CUSTOMER" | "SUBTYPE";
export type SystemTargetKind = "CATEGORY" | "PAYMENT_METHOD" | "SUBTYPE";
export type MatchKind = "regex" | "contains" | "equals";
export type StatusFilter = "active" | "inactive" | "all";

export const TENANT_TARGET_KINDS: { value: TargetKind; label: string }[] = [
  { value: "CATEGORY", label: "Categoria" },
  { value: "PAYMENT_METHOD", label: "Forma de pagamento" },
  { value: "SUPPLIER", label: "Fornecedor" },
  { value: "CUSTOMER", label: "Cliente" },
  { value: "SUBTYPE", label: "Subtipo (fiscal)" },
];

export const SYSTEM_TARGET_KINDS: { value: SystemTargetKind; label: string }[] = [
  { value: "CATEGORY", label: "Categoria" },
  { value: "PAYMENT_METHOD", label: "Forma de pagamento" },
  { value: "SUBTYPE", label: "Subtipo (fiscal)" },
];

export const MATCH_KINDS: { value: MatchKind; label: string }[] = [
  { value: "regex", label: "Regex" },
  { value: "contains", label: "Contém" },
  { value: "equals", label: "Igual a" },
];

export const ORIGIN_LABEL: Record<string, string> = {
  system_seed: "Sistema",
  admin: "Admin",
  user_promoted: "Promovido",
};

export const AUDIENCE_NULL = "__null__";
export const AUDIENCE_OPTIONS = [
  { value: AUDIENCE_NULL, label: "Todos os clientes" },
  { value: "restaurant", label: "Restaurante" },
];

export function isLovTargetKind(kind: TargetKind): boolean {
  return kind === "CATEGORY" || kind === "PAYMENT_METHOD" || kind === "SUBTYPE";
}

export type FormState = {
  id: string | null;
  targetKind: TargetKind;
  matchKind: MatchKind;
  pattern: string;
  lovTargetId: string;
  tvTargetId: string;
  category: string;
  confidence: string;
  priority: string;
  description: string;
};

export const EMPTY_TENANT_FORM: FormState = {
  id: null,
  targetKind: "CATEGORY",
  matchKind: "contains",
  pattern: "",
  lovTargetId: "",
  tvTargetId: "",
  category: AUDIENCE_NULL,
  confidence: "85",
  priority: "100",
  description: "",
};

export const EMPTY_SYSTEM_FORM: FormState = {
  id: null,
  targetKind: "PAYMENT_METHOD",
  matchKind: "contains",
  pattern: "",
  lovTargetId: "",
  tvTargetId: "",
  category: AUDIENCE_NULL,
  confidence: "70",
  priority: "100",
  description: "",
};
