// Generic name-only LOV quick-create dialog. Owns name input, similarity
// suggestions state, and the success/error toasts. Domain wrappers (e.g.
// CreatePaymentMethodDialog, CreateTransactionSubtypeDialog) pass a
// `mutateAsync` bound to their own tRPC create mutation; suggestions UI is
// opt-in via `suggestionsCopy` — omit it to skip the preflight branch.

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
import { toast } from "sonner";
import { LovSuggestionsView, type LovSuggestionsItem } from "@/components/lov/SuggestionsView";

export type LovQuickCreateInput = {
  name: string;
  confirmedDespiteSuggestions?: boolean;
};

export type LovQuickCreateOutcome =
  { kind: "created"; row: { id: string } } | { kind: "suggestions"; matches: LovSuggestionsItem[] };

export type LovQuickCreateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialName?: string;
  title: string;
  /** Toast text on successful create. Caller controls grammatical gender. */
  successMessage: string;
  mutateAsync: (input: LovQuickCreateInput) => Promise<LovQuickCreateOutcome>;
  isPending: boolean;
  onCreated?: (id: string) => void;
  /** Invalidates whatever query caches the new row should appear in. */
  onInvalidate: () => void;
  /** Present → render the similarity preflight UI on `kind: "suggestions"`.
   *  Absent → suggestions branch is treated as a no-op (caller's mutation is
   *  expected to skip the preflight on the server). */
  suggestionsCopy?: {
    pickedAlreadyTenant: string;
    pickedAlreadySystem: string;
  };
};

export function LovQuickCreateDialog({
  open,
  onOpenChange,
  initialName,
  title,
  successMessage,
  mutateAsync,
  isPending,
  onCreated,
  onInvalidate,
  suggestionsCopy,
}: LovQuickCreateDialogProps): ReactElement {
  const [name, setName] = useState("");
  const [suggestions, setSuggestions] = useState<LovSuggestionsItem[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(initialName ?? "");
    setSuggestions(null);
  }, [open, initialName]);

  function reset(): void {
    setName("");
    setSuggestions(null);
  }

  function handleOpenChange(next: boolean): void {
    if (!next) reset();
    onOpenChange(next);
  }

  async function runCreate(confirmedDespiteSuggestions: boolean): Promise<void> {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    try {
      const result = await mutateAsync({
        name: trimmed,
        ...(confirmedDespiteSuggestions ? { confirmedDespiteSuggestions: true } : {}),
      });
      if (result.kind === "suggestions") {
        if (suggestionsCopy !== undefined) setSuggestions(result.matches);
        return;
      }
      onInvalidate();
      toast.success(successMessage);
      onCreated?.(result.row.id);
      reset();
      onOpenChange(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erro ao criar.";
      toast.error(message);
    }
  }

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    void runCreate(false);
  }

  function handlePick(item: LovSuggestionsItem): void {
    if (suggestionsCopy === undefined) return;
    toast.info(
      item.source === "tenant-self"
        ? suggestionsCopy.pickedAlreadyTenant
        : suggestionsCopy.pickedAlreadySystem,
    );
    onInvalidate();
    onCreated?.(item.id);
    reset();
    onOpenChange(false);
  }

  function handleConfirmCreate(): void {
    void runCreate(true);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
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
            isPending={isPending}
          />
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="lov-qc-name">Nome</Label>
              <Input
                id="lov-qc-name"
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
                  handleOpenChange(false);
                }}
                disabled={isPending}
              >
                Cancelar
              </Button>
              <Button type="submit" disabled={isPending || name.trim().length < 1}>
                {isPending ? "Criando…" : "Criar"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
