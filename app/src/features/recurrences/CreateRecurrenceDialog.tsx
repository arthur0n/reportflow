// Modal for `recurrences.createWithSource` from a recurrence-first context
// (imports row + transaction row callers). Recurrence is always on; mode +
// pattern + count drive the cadence. The host owns submit + mutation routing
// and surfaces validation errors from the two state hooks.
//
// Composes the primitives any host can: `useTransactionFormState` (txn fields)
// + `useRecurrenceConfigState` (cadence) + `<TransactionFormFields>` (body)
// + `<RecurrenceModeFields>` (cadence UI) + `<QuickCreateHost>` (classifier
// quick-create dialogs). For the manual-CRUD flavor with a Repetir checkbox,
// see `features/transactions/CreateTransactionDialog.tsx`.

import { useState, type FormEvent, type ReactElement } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useLov } from "@/hooks/use-lov";
import { trpc } from "@/shared/lib/trpc";
import type { TransactionTypeCode } from "@shared/constants/transaction-types";
import { toast } from "sonner";
import { QuickCreateHost, type QuickCreateState } from "@/features/transactions/QuickCreateHost";
import { TransactionFormFields } from "@/features/transactions/TransactionFormFields";
import {
  useTransactionFormState,
  type TransactionFormInitialValues,
} from "@/features/transactions/use-transaction-form-state";
import { RecurrenceModeFields } from "./RecurrenceModeFields";
import { useRecurrenceConfigState } from "./use-recurrence-config-state";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transactionTypeCode: TransactionTypeCode;
  initialValues?: TransactionFormInitialValues;
  importRowId?: string;
  onCreated?: (sourceTransactionId: string) => void;
};

export function CreateRecurrenceDialog({
  open,
  onOpenChange,
  transactionTypeCode,
  initialValues,
  importRowId,
  onCreated,
}: Props): ReactElement {
  const utils = trpc.useUtils();
  const create = trpc.recurrences.createWithSource.useMutation({
    onSuccess: () => {
      void utils.transactions.invalidate();
      void utils.statementImports.invalidate();
      void utils.statementImportRows.invalidate();
      void utils.listOfValues.invalidate();
      void utils.tenantValues.invalidate();
    },
  });

  const types = useLov("TRANSACTION_TYPE");
  const transactionTypeId = types.byCode.get(transactionTypeCode)?.id ?? null;

  const form = useTransactionFormState({
    open,
    transactionTypeCode,
    ...(initialValues !== undefined ? { initialValues } : {}),
  });
  const recurrence = useRecurrenceConfigState({ open, defaultMode: "finite" });

  const [quickCreate, setQuickCreate] = useState<QuickCreateState>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  function handleSubmit(e: FormEvent): void {
    e.preventDefault();
    setSubmitError(null);
    if (transactionTypeId === null) {
      setSubmitError("TRANSACTION_TYPE não carregado.");
      return;
    }
    const sourceResult = form.buildSourcePayload(transactionTypeId);
    if (!sourceResult.ok) {
      setSubmitError(sourceResult.error);
      return;
    }
    const recResult = recurrence.buildConfig();
    if (!recResult.ok) {
      setSubmitError(recResult.error);
      return;
    }
    create.mutate(
      {
        source: sourceResult.value,
        ...(recResult.value !== null ? { recurrence: recResult.value } : {}),
        ...(importRowId !== undefined ? { importRowId } : {}),
      },
      {
        onSuccess: (result) => {
          const generatedMsg =
            result.generatedCount > 0 ? ` + ${String(result.generatedCount)} prevista(s)` : "";
          toast.success(`Transação criada${generatedMsg}.`);
          onCreated?.(result.source.id);
          onOpenChange(false);
        },
        onError: (err) => {
          setSubmitError(err.message);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Criar recorrência</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <RecurrenceModeFields
            mode={recurrence.mode}
            setMode={recurrence.setMode}
            recurrencePatternId={recurrence.recurrencePatternId}
            setRecurrencePatternId={recurrence.setRecurrencePatternId}
            repeatCount={recurrence.repeatCount}
            setRepeatCount={recurrence.setRepeatCount}
          />

          <TransactionFormFields
            form={form}
            transactionTypeCode={transactionTypeCode}
            setQuickCreate={setQuickCreate}
          />

          {submitError !== null && (
            <p className="text-sm text-red-600" role="alert">
              {submitError}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onOpenChange(false);
              }}
              disabled={create.isPending}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? "Criando…" : "Criar"}
            </Button>
          </div>
        </form>

        <QuickCreateHost
          state={quickCreate}
          onClose={() => {
            setQuickCreate(null);
          }}
          setters={{
            setCategoryId: form.setCategoryId,
            setSubtypeId: form.setSubtypeId,
            setPaymentMethodId: form.setPaymentMethodId,
            setCreditorId: form.setCreditorId,
            setCashBoxId: form.setCashBoxId,
            setBusinessUnitId: form.setBusinessUnitId,
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
