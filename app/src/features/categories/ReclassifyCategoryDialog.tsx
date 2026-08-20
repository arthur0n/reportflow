import { useEffect, useState, type ReactElement } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/shared/lib/trpc";
import { toast } from "sonner";

export type ReclassifiableCategory = {
  id: string;
  name: string;
  currentDreGroupCode: string;
};

export function ReclassifyCategoryDialog({
  category,
  open,
  onOpenChange,
}: {
  category: ReclassifiableCategory | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): ReactElement {
  const utils = trpc.useUtils();
  const dreGroupsQuery = trpc.dreGroups.list.useQuery();
  const countQuery = trpc.categories.transactionsCount.useQuery(
    category ? { ids: [category.id] } : { ids: [""] },
    { enabled: category !== null && open },
  );
  const [dreGroupCode, setDreGroupCode] = useState<string>("");

  useEffect(() => {
    if (category) setDreGroupCode(category.currentDreGroupCode);
  }, [category]);

  const reclassify = trpc.categories.reclassify.useMutation({
    onSuccess: () => {
      void utils.categories.list.invalidate();
      toast.success("Categoria reclassificada.");
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const counts = countQuery.data?.[0] ?? { activeCount: 0, inactiveCount: 0 };
  const totalAffected = counts.activeCount + counts.inactiveCount;

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    if (!category || dreGroupCode.length === 0) return;
    if (dreGroupCode === category.currentDreGroupCode) {
      onOpenChange(false);
      return;
    }
    reclassify.mutate({ id: category.id, dreGroupCode });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reclassificar “{category?.name ?? ""}”</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cat-reclass-dre">Novo grupo DRE</Label>
            <Select value={dreGroupCode} onValueChange={setDreGroupCode}>
              <SelectTrigger id="cat-reclass-dre">
                <SelectValue placeholder="Selecione um grupo" />
              </SelectTrigger>
              <SelectContent>
                {(dreGroupsQuery.data ?? []).map((g) => (
                  <SelectItem key={g.id} value={g.code}>
                    {g.code} — {g.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)]">
            {countQuery.isLoading
              ? "Carregando impacto…"
              : totalAffected === 0
                ? "Nenhuma transação referencia esta categoria."
                : `Esta categoria está em ${counts.activeCount} transação(ões) ativa(s)` +
                  (counts.inactiveCount > 0 ? ` e ${counts.inactiveCount} inativa(s)` : "") +
                  ". Os relatórios refletirão o novo grupo automaticamente."}
          </p>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onOpenChange(false);
              }}
              disabled={reclassify.isPending}
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              disabled={
                reclassify.isPending ||
                dreGroupCode.length === 0 ||
                dreGroupCode === category?.currentDreGroupCode
              }
            >
              {reclassify.isPending ? "Aplicando…" : "Reclassificar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
