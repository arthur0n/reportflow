// "A revisar" collapsible section of ReviewRows. Owns bulk-select state and
// renders one ReviewableRow per reviewable import row. Split out of
// ReviewRows.tsx for the max-lines-per-function lint rule.

import { useState, type ReactElement } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Checkbox } from "@/components/ui/checkbox";
import { trpc } from "@/shared/lib/trpc";
import { useLov } from "@/hooks/use-lov";
import { useTenantValues } from "@/hooks/use-tenant-values";
import type { PickerItem } from "@/components/inline-ref-picker";
import { CreateCategoryDialog } from "@/features/categories/CreateCategoryDialog";
import { TenantValueDialog } from "@/features/tenant-values/TenantValueDialog";
import { CreatePaymentMethodDialog } from "@/features/payment-methods/CreatePaymentMethodDialog";
import { CreateTransactionSubtypeDialog } from "@/features/transaction-subtypes/CreateTransactionSubtypeDialog";
import { CreateRecurrenceDialog } from "@/features/recurrences/CreateRecurrenceDialog";
import type { TransactionFormInitialValues } from "@/features/transactions/use-transaction-form-state";
import { centsToReais } from "@/features/transactions/transaction-form-utils";
import type { TransactionTypeCode } from "@shared/constants/transaction-types";
import { cleanDescriptionForCreate } from "@shared/imports/clean-description";
import {
  ReviewableRow,
  type FieldKey,
  type ImportRowData,
  type ResolveTarget,
} from "./ReviewableRow";

type DialogState =
  | { kind: "none" }
  | { kind: "category"; rowId: string; initialName: string }
  | {
      kind: "creditor";
      rowId: string;
      tvKind: "SUPPLIER" | "CUSTOMER";
      initialName: string;
    }
  | { kind: "paymentMethod"; rowId: string; initialName: string }
  | { kind: "subtype"; rowId: string; initialName: string }
  | { kind: "businessUnit"; rowId: string; initialName: string };

export function ReviewableSection({
  rows,
  onInvalidate,
}: {
  rows: ImportRowData[];
  onInvalidate: () => void;
}): ReactElement {
  const utils = trpc.useUtils();
  const subtypeLov = useLov("TRANSACTION_SUBTYPE");
  const categoryLov = useLov("CATEGORY");
  const dreGroupLov = useLov("DRE_GROUP");
  const paymentMethodLov = useLov("PAYMENT_METHOD");
  const supplierTv = useTenantValues({ kind: "SUPPLIER" });
  const customerTv = useTenantValues({ kind: "CUSTOMER" });
  const businessUnitTv = useTenantValues({ kind: "BUSINESS_UNIT" });
  const noiseLov = useLov("DESCRIPTION_NOISE");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [dialogState, setDialogState] = useState<DialogState>({ kind: "none" });
  const [recurrenceFor, setRecurrenceFor] = useState<ImportRowData | null>(null);

  const reviewMutation = trpc.statementImportRows.review.useMutation({
    onSuccess: onInvalidate,
  });
  const setClassificationMutation = trpc.statementImportRows.setClassification.useMutation({
    onSuccess: onInvalidate,
  });
  const setAccrualDateMutation = trpc.statementImportRows.setAccrualDate.useMutation({
    onSuccess: onInvalidate,
  });
  const setReferenceMutation = trpc.statementImportRows.setReference.useMutation({
    onSuccess: onInvalidate,
  });
  const reviewBulkMutation = trpc.statementImportRows.reviewBulk.useMutation({
    onSuccess: () => {
      setSelectedIds(new Set());
      onInvalidate();
    },
  });

  const ids = rows.map((r) => r.id);
  const selectedArr = ids.filter((id) => selectedIds.has(id));
  const allSelected = ids.length > 0 && selectedArr.length === ids.length;
  const someSelected = selectedArr.length > 0 && !allSelected;
  const isBulkBusy = reviewBulkMutation.isPending;

  const toggleRow = (id: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = (): void => {
    if (allSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(ids));
  };

  const applyBulk = (action: "new" | "skip"): void => {
    const targets = selectedArr.length > 0 ? selectedArr : ids;
    if (targets.length === 0) return;
    reviewBulkMutation.mutate({ rowIds: targets, action });
  };

  const bulkLabel =
    selectedArr.length > 0 ? `(${String(selectedArr.length)} selecionada(s))` : "(todas)";

  const fetchSuggestions = async (
    rowId: string,
    target: ResolveTarget,
    candidate: string,
  ): Promise<PickerItem[]> => {
    const result = await utils.statementImportRows.resolve.fetch({
      importRowId: rowId,
      target,
      candidate,
    });
    if (result.status === "matched") {
      return [{ id: result.id, label: result.value, sublabel: result.code, highlighted: true }];
    }
    if (result.status === "suggested") {
      return result.candidates.map((c) => ({
        id: c.id,
        label: c.value,
        sublabel: c.code,
        highlighted: true,
      }));
    }
    return [];
  };

  // Picking a value in any classification field updates the row in place
  // without flipping its review status. Moving a row out of "A revisar"
  // requires an explicit action (the Criar / Pular / match buttons).
  //
  // Side effect: picking a supplier/customer that has a default category
  // (tenant_values.parent_lov → CATEGORY) auto-fills the row's categoryId,
  // but only when the row has no category yet — never override a user pick.
  const setClassification = (rowId: string, field: FieldKey, id: string | null): void => {
    const payload: {
      id: string;
      categoryId?: string | null;
      creditorId?: string | null;
      paymentMethodId?: string | null;
      subtypeId?: string | null;
    } = { id: rowId, [field]: id };

    if (field === "creditorId" && id !== null) {
      const row = rows.find((r) => r.id === rowId);
      if (row?.categoryId === null) {
        const creditor = supplierTv.byId.get(id) ?? customerTv.byId.get(id);
        const parent = creditor?.parent ?? null;
        if (parent !== null && parent.deletedAt === null) {
          payload.categoryId = parent.id;
        }
      }
    }

    setClassificationMutation.mutate(payload);
  };

  const handleDialogCreated = (field: FieldKey, rowId: string, newId: string): void => {
    setClassification(rowId, field, newId);
  };

  return (
    <Collapsible defaultOpen className="mt-6">
      <CollapsibleTrigger className="group flex items-center gap-2 mb-3 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]">
        <ChevronRight className="h-3.5 w-3.5 text-[color:var(--ink-mute)] transition-transform duration-200 group-data-[state=open]:rotate-90" />
        <span className="text-[length:var(--fs-eyebrow)] uppercase tracking-[0.14em] font-[550] text-[color:var(--ink)]">
          A revisar
        </span>
        <span className="tabular-nums text-[length:var(--fs-eyebrow)] text-[color:var(--ink-mute)]">
          · {rows.length}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex items-center gap-2 mb-3">
          <Button
            variant="outline"
            size="sm"
            disabled={isBulkBusy || ids.length === 0}
            onClick={() => {
              applyBulk("new");
            }}
          >
            Criar {bulkLabel}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={isBulkBusy || ids.length === 0}
            onClick={() => {
              applyBulk("skip");
            }}
          >
            Pular {bulkLabel}
          </Button>
          {selectedArr.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSelectedIds(new Set());
              }}
            >
              Limpar seleção
            </Button>
          )}
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={allSelected || (someSelected && "indeterminate")}
                  onCheckedChange={toggleAll}
                  aria-label="Selecionar todas as linhas"
                />
              </TableHead>
              <TableHead>#</TableHead>
              <TableHead>Data</TableHead>
              <TableHead>Competência</TableHead>
              <TableHead>Ref</TableHead>
              <TableHead className="text-right">Valor</TableHead>
              <TableHead>Descrição</TableHead>
              <TableHead>Decisão</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <ReviewableRow
                key={row.id}
                row={row}
                subtypeLov={subtypeLov}
                categoryLov={categoryLov}
                dreGroupLov={dreGroupLov}
                paymentMethodLov={paymentMethodLov}
                supplierTv={supplierTv}
                customerTv={customerTv}
                businessUnitTv={businessUnitTv}
                isSelected={selectedIds.has(row.id)}
                onToggleSelect={() => {
                  toggleRow(row.id);
                }}
                onReview={(action, matchedTransactionId) => {
                  reviewMutation.mutate({ id: row.id, action, matchedTransactionId });
                }}
                onSetClassification={(field, id) => {
                  setClassification(row.id, field, id);
                }}
                onSetAccrualDate={(accrualDate) => {
                  setAccrualDateMutation.mutate({ id: row.id, accrualDate });
                }}
                onSetReference={(reference) => {
                  setReferenceMutation.mutate({ id: row.id, reference });
                }}
                onRequestCreateCategory={(name) => {
                  setDialogState({ kind: "category", rowId: row.id, initialName: name });
                }}
                onRequestCreateCreditor={(tvKind, name) => {
                  setDialogState({ kind: "creditor", rowId: row.id, tvKind, initialName: name });
                }}
                onRequestCreatePaymentMethod={(name) => {
                  setDialogState({ kind: "paymentMethod", rowId: row.id, initialName: name });
                }}
                onRequestCreateSubtype={(name) => {
                  setDialogState({ kind: "subtype", rowId: row.id, initialName: name });
                }}
                onRequestCreateBusinessUnit={(name) => {
                  setDialogState({ kind: "businessUnit", rowId: row.id, initialName: name });
                }}
                onRequestCreateRecurrence={() => {
                  setRecurrenceFor(row);
                }}
                creditorCreateSuggestion={cleanDescriptionForCreate(
                  row.description ?? "",
                  noiseLov.items.map((i) => i.value),
                )}
                fetchSuggestions={fetchSuggestions}
              />
            ))}
          </TableBody>
        </Table>
      </CollapsibleContent>

      <QuickCreateDialogs
        dialogState={dialogState}
        onClose={() => {
          setDialogState({ kind: "none" });
        }}
        onCreated={handleDialogCreated}
      />

      <ImportRecurrenceDialog
        row={recurrenceFor}
        onClose={() => {
          setRecurrenceFor(null);
        }}
        onInvalidate={onInvalidate}
      />
    </Collapsible>
  );
}

function ImportRecurrenceDialog({
  row,
  onClose,
  onInvalidate,
}: {
  row: ImportRowData | null;
  onClose: () => void;
  onInvalidate: () => void;
}): ReactElement {
  return (
    <CreateRecurrenceDialog
      open={row !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      transactionTypeCode={row !== null ? typeCodeFor(row) : "EXPENSE"}
      {...(row !== null ? { initialValues: initialValuesForRow(row) } : {})}
      {...(row !== null ? { importRowId: row.id } : {})}
      onCreated={() => {
        onClose();
        onInvalidate();
      }}
    />
  );
}

function typeCodeFor(row: ImportRowData): TransactionTypeCode {
  if (row.actualAmount !== null && row.actualAmount > 0n) return "REVENUE";
  return "EXPENSE";
}

function initialValuesForRow(row: ImportRowData): TransactionFormInitialValues {
  const out: TransactionFormInitialValues = {};
  if (row.description !== null) out.description = row.description;
  if (row.reference !== null) out.reference = row.reference;
  const accrual = row.accrualDate ?? row.actualDate;
  if (accrual !== null) {
    out.accrualDate = accrual;
    out.dueDate = accrual;
  }
  if (row.actualDate !== null) out.actualDate = row.actualDate;
  if (row.actualAmount !== null) {
    const reais = centsToReais(row.actualAmount);
    out.forecastReais = reais;
    out.actualReais = reais;
  }
  if (row.creditorId !== null) out.creditorId = row.creditorId;
  if (row.categoryId !== null) out.categoryId = row.categoryId;
  if (row.paymentMethodId !== null) out.paymentMethodId = row.paymentMethodId;
  if (row.subtypeId !== null) out.subtypeId = row.subtypeId;
  if (row.businessUnitId !== null) out.businessUnitId = row.businessUnitId;
  return out;
}

function QuickCreateDialogs({
  dialogState,
  onClose,
  onCreated,
}: {
  dialogState: DialogState;
  onClose: () => void;
  onCreated: (field: FieldKey, rowId: string, newId: string) => void;
}): ReactElement {
  const handleOpenChange = (next: boolean): void => {
    if (!next) onClose();
  };
  return (
    <>
      <CreateCategoryDialog
        open={dialogState.kind === "category"}
        onOpenChange={handleOpenChange}
        {...(dialogState.kind === "category" ? { initialName: dialogState.initialName } : {})}
        onCreated={(id) => {
          if (dialogState.kind === "category") onCreated("categoryId", dialogState.rowId, id);
        }}
      />

      <TenantValueDialog
        kind={dialogState.kind === "creditor" ? dialogState.tvKind : "SUPPLIER"}
        tenantValue={null}
        open={dialogState.kind === "creditor"}
        onOpenChange={handleOpenChange}
        {...(dialogState.kind === "creditor" ? { initialName: dialogState.initialName } : {})}
        onCreated={(id) => {
          if (dialogState.kind === "creditor") onCreated("creditorId", dialogState.rowId, id);
        }}
      />

      <CreatePaymentMethodDialog
        open={dialogState.kind === "paymentMethod"}
        onOpenChange={handleOpenChange}
        {...(dialogState.kind === "paymentMethod" ? { initialName: dialogState.initialName } : {})}
        onCreated={(id) => {
          if (dialogState.kind === "paymentMethod") {
            onCreated("paymentMethodId", dialogState.rowId, id);
          }
        }}
      />

      <TenantValueDialog
        kind="BUSINESS_UNIT"
        tenantValue={null}
        open={dialogState.kind === "businessUnit"}
        onOpenChange={handleOpenChange}
        {...(dialogState.kind === "businessUnit" ? { initialName: dialogState.initialName } : {})}
        onCreated={(id) => {
          if (dialogState.kind === "businessUnit") {
            onCreated("businessUnitId", dialogState.rowId, id);
          }
        }}
      />

      <CreateTransactionSubtypeDialog
        open={dialogState.kind === "subtype"}
        onOpenChange={handleOpenChange}
        {...(dialogState.kind === "subtype" ? { initialName: dialogState.initialName } : {})}
        onCreated={(id) => {
          if (dialogState.kind === "subtype") onCreated("subtypeId", dialogState.rowId, id);
        }}
      />
    </>
  );
}
