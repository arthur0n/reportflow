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
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { trpc } from "@/shared/lib/trpc";
import { toast } from "sonner";

export type EditableCategory = {
  id: string;
  name: string;
  description: string | null;
};

export function EditCategoryDialog({
  category,
  open,
  onOpenChange,
}: {
  category: EditableCategory | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): ReactElement {
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (category) {
      setName(category.name);
      setDescription(category.description ?? "");
    }
  }, [category]);

  const update = trpc.categories.update.useMutation({
    onSuccess: () => {
      void utils.categories.list.invalidate();
      toast.success("Categoria atualizada.");
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    if (!category || name.trim().length === 0) return;
    update.mutate({
      id: category.id,
      name: name.trim(),
      description: description.trim().length > 0 ? description.trim() : null,
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Editar categoria</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cat-edit-name">Nome</Label>
            <Input
              id="cat-edit-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              maxLength={200}
              required
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cat-edit-desc">Descrição</Label>
            <Textarea
              id="cat-edit-desc"
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
              }}
              maxLength={500}
              rows={3}
            />
          </div>
          <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
            Para mudar o grupo DRE, use a ação “Reclassificar”.
          </p>
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
            <Button type="submit" disabled={update.isPending || name.trim().length === 0}>
              {update.isPending ? "Salvando…" : "Salvar"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
