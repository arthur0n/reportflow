import type { ReactElement } from "react";
import { Button } from "@/components/ui/button";

export type LovSuggestionsItem = {
  id: string;
  value: string;
  similarity: number;
  source: "system" | "tenant-self" | "tenant-other";
};

const SOURCE_LABELS: Record<LovSuggestionsItem["source"], string> = {
  system: "Sistema",
  "tenant-self": "Já cadastrado",
  "tenant-other": "Outro cliente",
};

/**
 * Renders LOV similarity matches inside a create dialog. The user picks an
 * existing row (cancels the create) or confirms creation despite suggestions.
 *
 * "tenant-other" is included for completeness but the pick action is disabled
 * — those rows belong to other tenants and aren't selectable.
 */
export function LovSuggestionsView({
  candidateName,
  suggestions,
  onPick,
  onConfirmCreate,
  onCancel,
  isPending,
}: {
  candidateName: string;
  suggestions: LovSuggestionsItem[];
  onPick: (item: LovSuggestionsItem) => void;
  onConfirmCreate: () => void;
  onCancel: () => void;
  isPending: boolean;
}): ReactElement {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Encontramos itens parecidos com <strong>{candidateName}</strong>. Para evitar duplicidade,
        considere usar um dos abaixo.
      </p>
      <ul className="flex flex-col gap-2">
        {suggestions.map((s) => (
          <li key={s.id} className="flex items-center justify-between rounded border p-3">
            <div className="flex flex-col">
              <span className="font-medium">{s.value}</span>
              <span className="text-xs text-muted-foreground">
                {SOURCE_LABELS[s.source]} · {Math.round(s.similarity * 100)}% similar
              </span>
            </div>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => {
                onPick(s);
              }}
              disabled={isPending || s.source === "tenant-other"}
            >
              Usar este
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
          Cancelar
        </Button>
        <Button type="button" onClick={onConfirmCreate} disabled={isPending}>
          {isPending ? "Criando…" : "Criar mesmo assim"}
        </Button>
      </div>
    </div>
  );
}
