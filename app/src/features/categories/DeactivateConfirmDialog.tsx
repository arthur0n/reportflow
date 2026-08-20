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

export type DeactivableCategory = {
  id: string;
  name: string;
};

export function DeactivateConfirmDialog({
  category,
  open,
  onOpenChange,
}: {
  category: DeactivableCategory | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): ReactElement {
  const utils = trpc.useUtils();
  const countQuery = trpc.categories.transactionsCount.useQuery(
    category ? { ids: [category.id] } : { ids: [""] },
    { enabled: category !== null && open },
  );

  const deactivate = trpc.categories.deactivate.useMutation({
    onSuccess: () => {
      void utils.categories.list.invalidate();
      toast.success("Categoria inativada.");
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
          <DialogTitle>Inativar “{category?.name ?? ""}”?</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)]">
            Categorias inativas não aparecem em dropdowns de novas transações nem como sugestão de
            credor. Transações já lançadas continuam classificadas normalmente.
          </p>
          <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)]">
            {countQuery.isLoading
              ? "Carregando impacto…"
              : counts.activeCount === 0 && counts.inactiveCount === 0
                ? "Nenhuma transação referencia esta categoria."
                : `Esta categoria está em ${counts.activeCount} transação(ões) ativa(s)` +
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
              if (category) deactivate.mutate(category.id);
            }}
            disabled={deactivate.isPending || category === null}
          >
            {deactivate.isPending ? "Inativando…" : "Inativar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
