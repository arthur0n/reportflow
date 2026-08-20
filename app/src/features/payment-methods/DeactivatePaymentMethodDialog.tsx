import type { ReactElement } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { trpc } from "@/shared/lib/trpc";
import { toast } from "sonner";

export type DeactivablePaymentMethod = {
  id: string;
  name: string;
};

export function DeactivatePaymentMethodDialog({
  paymentMethod,
  open,
  onOpenChange,
}: {
  paymentMethod: DeactivablePaymentMethod | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): ReactElement {
  const utils = trpc.useUtils();
  const countQuery = trpc.paymentMethods.transactionsCount.useQuery(
    paymentMethod ? { ids: [paymentMethod.id] } : { ids: [""] },
    { enabled: paymentMethod !== null && open },
  );

  const deactivate = trpc.paymentMethods.deactivate.useMutation({
    onSuccess: () => {
      void utils.paymentMethods.invalidate();
      void utils.listOfValues.invalidate();
      toast.success("Forma de pagamento inativada.");
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const counts = countQuery.data?.[0] ?? { activeCount: 0, inactiveCount: 0 };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Inativar “{paymentMethod?.name ?? ""}”?</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)]">
            Formas de pagamento inativas não aparecem em dropdowns de novas transações. Transações
            já lançadas continuam vinculadas normalmente.
          </p>
          <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)]">
            {countQuery.isLoading
              ? "Carregando impacto…"
              : counts.activeCount === 0 && counts.inactiveCount === 0
                ? "Nenhuma transação referencia esta forma de pagamento."
                : `Esta forma de pagamento está em ${counts.activeCount} transação(ões) ativa(s)` +
                  (counts.inactiveCount > 0 ? ` e ${counts.inactiveCount} inativa(s)` : "") +
                  "."}
          </p>
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
            disabled={deactivate.isPending}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              if (paymentMethod) deactivate.mutate(paymentMethod.id);
            }}
            disabled={deactivate.isPending || paymentMethod === null}
          >
            {deactivate.isPending ? "Inativando…" : "Inativar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
