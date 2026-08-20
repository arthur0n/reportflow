// Manual-CRUD create-transaction modal. Two tabs: "Transação" (always
// visible) hosts the standard transaction-shape form body; "Recorrência"
// (enabled only when "Repetir?" is checked in the dialog footer) hosts the
// cadence controls.
//
// One submit button at the dialog footer routes to the right mutation:
//   - Repetir off → transactions.create (single transaction)
//   - Repetir on  → recurrences.createWithSource (source + ESTIMADO siblings)
//
// Composition convention any future host follows: useTransactionFormState +
// (optional) useRecurrenceConfigState + TransactionFormFields + (optional)
// RecurrenceModeFields + QuickCreateHost. Validation surfaces via the two
// hooks' buildSourcePayload / buildConfig returning {ok, value | error}.

import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { useLov } from "@/hooks/use-lov";
import { trpc } from "@/shared/lib/trpc";
import { toast } from "sonner";
import type { TransactionTypeCode } from "@shared/constants/transaction-types";
import { QuickCreateHost, type QuickCreateState } from "./QuickCreateHost";
import { TransactionFormFields } from "./TransactionFormFields";
import { useTransactionFormState } from "./use-transaction-form-state";
import { useCreateTransaction } from "./use-create-transaction";
import { RecurrenceModeFields } from "@/features/recurrences/RecurrenceModeFields";
import { useRecurrenceConfigState } from "@/features/recurrences/use-recurrence-config-state";

type Tab = "transacao" | "recorrencia";

const TITLE_BY_CODE: Record<TransactionTypeCode, string> = {
  EXPENSE: "Nova despesa",
  REVENUE: "Novo recebimento",
  TRANSFER_INTERNAL: "Nova transferência",
  CASH_DRAWER_IN: "Entrada de caixa",
  CASH_DRAWER_OUT: "Saída de caixa",
  CASH_DRAWER_SHORT: "Quebra de caixa",
  ADJUSTMENT: "Ajuste",
};

export function CreateTransactionDialog({
  open,
  onOpenChange,
  transactionTypeCode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  transactionTypeCode: TransactionTypeCode;
}): ReactElement {
  const types = useLov("TRANSACTION_TYPE");
  const transactionTypeId = types.byCode.get(transactionTypeCode)?.id ?? null;

  const utils = trpc.useUtils();
  const createTxn = useCreateTransaction();
  const createWithRec = trpc.recurrences.createWithSource.useMutation({
    onSuccess: () => {
      void utils.transactions.invalidate();
      void utils.listOfValues.invalidate();
      void utils.tenantValues.invalidate();
    },
  });

  const form = useTransactionFormState({ open, transactionTypeCode });
  const recurrence = useRecurrenceConfigState({ open, defaultMode: "finite" });

  const [repetir, setRepetir] = useState(false);
  const [tab, setTab] = useState<Tab>("transacao");
  const [quickCreate, setQuickCreate] = useState<QuickCreateState>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset dialog-owned state on open transition.
  useEffect(() => {
    if (!open) return;
    setRepetir(false);
    setTab("transacao");
    setQuickCreate(null);
    setSubmitError(null);
  }, [open]);

  // If the user unchecks Repetir while on the Recorrência tab, fall back to
  // Transação so the disabled tab isn't left visually selected.
  useEffect(() => {
    if (!repetir && tab === "recorrencia") setTab("transacao");
  }, [repetir, tab]);

  const isPending = createTxn.isPending || createWithRec.isPending;

  function handleSubmit(e: FormEvent): void {
    e.preventDefault();
    setSubmitError(null);
    if (transactionTypeId === null) {
      setSubmitError("TRANSACTION_TYPE não carregado.");
      return;
    }
    const sourceResult = form.buildSourcePayload(transactionTypeId);
    if (!sourceResult.ok) {
      setTab("transacao");
      setSubmitError(sourceResult.error);
      return;
    }
    if (!repetir) {
      createTxn.mutate(sourceResult.value, {
        onSuccess: () => {
          toast.success("Transação criada.");
          onOpenChange(false);
        },
        onError: (err) => {
          setSubmitError(err.message);
        },
      });
      return;
    }
    const recResult = recurrence.buildConfig();
    if (!recResult.ok || recResult.value === null) {
      setTab("recorrencia");
      setSubmitError(recResult.ok ? "Selecione a periodicidade." : recResult.error);
      return;
    }
    createWithRec.mutate(
      { source: sourceResult.value, recurrence: recResult.value },
      {
        onSuccess: (result) => {
          const generatedMsg =
            result.generatedCount > 0 ? ` + ${String(result.generatedCount)} prevista(s)` : "";
          toast.success(`Transação criada${generatedMsg}.`);
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
          <DialogTitle>{TITLE_BY_CODE[transactionTypeCode]}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Tabs
            value={tab}
            onValueChange={(v) => {
              setTab(v as Tab);
            }}
          >
            <TabsList>
              <TabsTrigger value="transacao">Transação</TabsTrigger>
              <TabsTrigger value="recorrencia" disabled={!repetir}>
                Recorrência
              </TabsTrigger>
            </TabsList>

            <TabsContent value="transacao" className="flex flex-col gap-4">
              <TransactionFormFields
                form={form}
                transactionTypeCode={transactionTypeCode}
                setQuickCreate={setQuickCreate}
              />
            </TabsContent>

            <TabsContent value="recorrencia" className="flex flex-col gap-4">
              <RecurrenceModeFields
                mode={recurrence.mode}
                setMode={recurrence.setMode}
                recurrencePatternId={recurrence.recurrencePatternId}
                setRecurrencePatternId={recurrence.setRecurrencePatternId}
                repeatCount={recurrence.repeatCount}
                setRepeatCount={recurrence.setRepeatCount}
              />
            </TabsContent>
          </Tabs>

          {submitError !== null && (
            <p className="text-sm text-red-600" role="alert">
              {submitError}
            </p>
          )}

          <div className="flex items-center justify-between gap-2 border-t pt-4">
            <label htmlFor="repetir" className="flex items-center gap-2 text-sm cursor-pointer">
              <Checkbox
                id="repetir"
                checked={repetir}
                onCheckedChange={(v) => {
                  setRepetir(v === true);
                }}
              />
              <Label htmlFor="repetir" className="cursor-pointer">
                Repetir?
              </Label>
            </label>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  onOpenChange(false);
                }}
                disabled={isPending}
              >
                Cancelar
              </Button>
              <Button type="submit" disabled={isPending}>
                {isPending ? "Criando…" : "Criar"}
              </Button>
            </div>
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
