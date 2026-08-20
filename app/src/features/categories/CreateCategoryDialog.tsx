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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/shared/lib/trpc";
import { toast } from "sonner";
import { LovSuggestionsView, type LovSuggestionsItem } from "@/components/lov/SuggestionsView";

export function CreateCategoryDialog({
  open,
  onOpenChange,
  initialName,
  initialDreGroupCode,
  initialDescription,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialName?: string;
  initialDreGroupCode?: string;
  initialDescription?: string;
  onCreated?: (id: string) => void;
}): ReactElement {
  const utils = trpc.useUtils();
  const dreGroupsQuery = trpc.dreGroups.list.useQuery();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [dreGroupCode, setDreGroupCode] = useState<string>("");
  const [suggestions, setSuggestions] = useState<LovSuggestionsItem[] | null>(null);

  // Seed from initial* on each open transition. Caller controls re-opens with
  // different defaults (e.g. picker passes the typed name).
  useEffect(() => {
    if (!open) return;
    setName(initialName ?? "");
    setDescription(initialDescription ?? "");
    setDreGroupCode(initialDreGroupCode ?? "");
    setSuggestions(null);
  }, [open, initialName, initialDescription, initialDreGroupCode]);

  const create = trpc.categories.create.useMutation({
    onSuccess: (result) => {
      if (result.kind === "suggestions") {
        setSuggestions(result.matches);
        return;
      }
      void utils.categories.list.invalidate();
      void utils.listOfValues.invalidate();
      toast.success("Categoria criada.");
      onCreated?.(result.row.id);
      reset();
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  function reset(): void {
    setName("");
    setDescription("");
    setDreGroupCode("");
    setSuggestions(null);
  }

  function handleOpenChange(next: boolean): void {
    if (!next) reset();
    onOpenChange(next);
  }

  function buildPayload(extras: { confirmedDespiteSuggestions?: boolean } = {}): {
    name: string;
    dreGroupCode: string;
    description?: string;
    confirmedDespiteSuggestions?: boolean;
  } {
    return {
      name: name.trim(),
      dreGroupCode,
      ...(description.trim().length > 0 ? { description: description.trim() } : {}),
      ...(extras.confirmedDespiteSuggestions === true ? { confirmedDespiteSuggestions: true } : {}),
    };
  }

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    if (name.trim().length === 0 || dreGroupCode.length === 0) return;
    create.mutate(buildPayload());
  }

  function handlePick(item: LovSuggestionsItem): void {
    toast.info(
      item.source === "tenant-self"
        ? "Esta categoria já está cadastrada."
        : "Esta categoria já está disponível no sistema.",
    );
    void utils.listOfValues.invalidate();
    onCreated?.(item.id);
    reset();
    onOpenChange(false);
  }

  function handleConfirmCreate(): void {
    create.mutate(buildPayload({ confirmedDespiteSuggestions: true }));
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nova categoria</DialogTitle>
        </DialogHeader>
        {suggestions !== null ? (
          <LovSuggestionsView
            candidateName={name.trim()}
            suggestions={suggestions}
            onPick={handlePick}
            onConfirmCreate={handleConfirmCreate}
            onCancel={() => {
              handleOpenChange(false);
            }}
            isPending={create.isPending}
          />
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cat-name">Nome</Label>
              <Input
                id="cat-name"
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
              <Label htmlFor="cat-dre">Grupo DRE</Label>
              <Select value={dreGroupCode} onValueChange={setDreGroupCode}>
                <SelectTrigger id="cat-dre">
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
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="cat-desc">Descrição (opcional)</Label>
              <Textarea
                id="cat-desc"
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                }}
                maxLength={500}
                rows={3}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  handleOpenChange(false);
                }}
                disabled={create.isPending}
              >
                Cancelar
              </Button>
              <Button
                type="submit"
                disabled={create.isPending || name.trim().length === 0 || dreGroupCode.length === 0}
              >
                {create.isPending ? "Criando…" : "Criar"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
