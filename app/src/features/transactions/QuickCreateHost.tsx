import { type ReactElement } from "react";
import { CreateCategoryDialog } from "@/features/categories/CreateCategoryDialog";
import { CreatePaymentMethodDialog } from "@/features/payment-methods/CreatePaymentMethodDialog";
import { CreateTransactionSubtypeDialog } from "@/features/transaction-subtypes/CreateTransactionSubtypeDialog";
import { TenantValueDialog } from "@/features/tenant-values/TenantValueDialog";

export type QuickCreateKind =
  "category" | "subtype" | "paymentMethod" | "supplier" | "customer" | "cashBox" | "businessUnit";

export type QuickCreateState = { kind: QuickCreateKind; name: string } | null;

export type QuickCreateSetters = {
  setCategoryId: (id: string) => void;
  setSubtypeId: (id: string) => void;
  setPaymentMethodId: (id: string) => void;
  setCreditorId: (id: string) => void;
  setCashBoxId: (id: string) => void;
  setBusinessUnitId: (id: string) => void;
};

/**
 * Renders all seven quick-create dialogs the transaction form delegates to.
 * Centralizing the dialog wiring here keeps TransactionForm focused on the
 * input fields and the suggest pipeline.
 */
export function QuickCreateHost({
  state,
  onClose,
  setters,
}: {
  state: QuickCreateState;
  onClose: () => void;
  setters: QuickCreateSetters;
}): ReactElement {
  const handleOpen =
    (kind: QuickCreateKind) =>
    (next: boolean): void => {
      if (!next && state?.kind === kind) onClose();
    };
  const initial = (kind: QuickCreateKind): string => (state?.kind === kind ? state.name : "");

  return (
    <>
      <CreateCategoryDialog
        open={state?.kind === "category"}
        onOpenChange={handleOpen("category")}
        initialName={initial("category")}
        onCreated={(id) => {
          setters.setCategoryId(id);
          onClose();
        }}
      />
      <CreatePaymentMethodDialog
        open={state?.kind === "paymentMethod"}
        onOpenChange={handleOpen("paymentMethod")}
        initialName={initial("paymentMethod")}
        onCreated={(id) => {
          setters.setPaymentMethodId(id);
          onClose();
        }}
      />
      <CreateTransactionSubtypeDialog
        open={state?.kind === "subtype"}
        onOpenChange={handleOpen("subtype")}
        initialName={initial("subtype")}
        onCreated={(id) => {
          setters.setSubtypeId(id);
          onClose();
        }}
      />
      <TenantValueDialog
        kind="SUPPLIER"
        tenantValue={null}
        open={state?.kind === "supplier"}
        onOpenChange={handleOpen("supplier")}
        initialName={initial("supplier")}
        onCreated={(id) => {
          setters.setCreditorId(id);
          onClose();
        }}
      />
      <TenantValueDialog
        kind="CUSTOMER"
        tenantValue={null}
        open={state?.kind === "customer"}
        onOpenChange={handleOpen("customer")}
        initialName={initial("customer")}
        onCreated={(id) => {
          setters.setCreditorId(id);
          onClose();
        }}
      />
      <TenantValueDialog
        kind="CASH_BOX"
        tenantValue={null}
        open={state?.kind === "cashBox"}
        onOpenChange={handleOpen("cashBox")}
        initialName={initial("cashBox")}
        onCreated={(id) => {
          setters.setCashBoxId(id);
          onClose();
        }}
      />
      <TenantValueDialog
        kind="BUSINESS_UNIT"
        tenantValue={null}
        open={state?.kind === "businessUnit"}
        onOpenChange={handleOpen("businessUnit")}
        initialName={initial("businessUnit")}
        onCreated={(id) => {
          setters.setBusinessUnitId(id);
          onClose();
        }}
      />
    </>
  );
}
