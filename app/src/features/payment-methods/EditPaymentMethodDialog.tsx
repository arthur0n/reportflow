import { useEffect, useState, type ReactElement } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { trpc } from "@/shared/lib/trpc";
import { toast } from "sonner";

export type EditablePaymentMethod = {
  id: string;
  name: string;
};

export function EditPaymentMethodDialog({
  paymentMethod,
  open,
  onOpenChange,
}: {
  paymentMethod: EditablePaymentMethod | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): ReactElement {
  const utils = trpc.useUtils();
  const [name, setName] = useState("");

  useEffect(() => {
    if (paymentMethod) {
      setName(paymentMethod.name);
    }
  }, [paymentMethod]);

  const update = trpc.paymentMethods.update.useMutation({
    onSuccess: () => {
      void utils.paymentMethods.invalidate();
      void utils.listOfValues.invalidate();
      toast.success("Forma de pagamento atualizada.");
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    if (!paymentMethod || name.trim().length < 1) return;
    update.mutate({ id: paymentMethod.id, name: name.trim() });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Editar forma de pagamento</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pm-edit-name">Nome</Label>
            <Input
              id="pm-edit-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              maxLength={200}
              required
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                onOpenChange(false);
              }}
              disabled={update.isPending}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={update.isPending || name.trim().length < 1}>
              {update.isPending ? "Salvando…" : "Salvar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
