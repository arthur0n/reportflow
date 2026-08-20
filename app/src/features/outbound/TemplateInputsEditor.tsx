// app/src/features/outbound/TemplateInputsEditor.tsx
//
// §3.2's named-input declaration, as rows. A role is a KEY plus the document
// type it binds, whether the report can be published without it, and how many
// documents may fill it.
//
// The key field is the one that matters and the one users get wrong: it
// becomes a top-level Handlebars path (`{{nota.titular}}`), so it has to be a
// bare identifier. The server refuses anything else (shared/validation/
// outbound-schemas.ts) — the hint below is there so the refusal is not the
// first time anyone hears about the rule.

import type { ReactElement } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { DocumentTypeOption } from "@/hooks/use-document-types";

export type RoleRow = {
  key: string;
  documentTypeId: string;
  cardinality: "one" | "many";
  required: boolean;
};

const EMPTY_ROLE: RoleRow = {
  key: "",
  documentTypeId: "",
  cardinality: "one",
  required: true,
};

export function TemplateInputsEditor({
  rows,
  options,
  disabled,
  onChange,
}: {
  rows: readonly RoleRow[];
  options: readonly DocumentTypeOption[];
  disabled: boolean;
  onChange: (rows: RoleRow[]) => void;
}): ReactElement {
  const update = (index: number, patch: Partial<RoleRow>): void => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 && (
        <p className="text-[length:var(--fs-body-sm)] italic text-[color:var(--ink-mute)]">
          Nenhum papel declarado. Um modelo sem papéis não lê nenhum documento.
        </p>
      )}

      {rows.map((row, index) => (
        <div
          key={index}
          className="grid grid-cols-1 gap-3 border-b border-[color:var(--rule)] pb-3 md:grid-cols-[1fr_1.6fr_auto_auto_auto] md:items-end"
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor={`role-key-${String(index)}`}>Papel</Label>
            <Input
              id={`role-key-${String(index)}`}
              value={row.key}
              disabled={disabled}
              placeholder="nota"
              onChange={(e) => {
                update(index, { key: e.target.value });
              }}
            />
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor={`role-type-${String(index)}`}>Tipo de documento</Label>
            <Select
              value={row.documentTypeId}
              disabled={disabled}
              onValueChange={(value) => {
                update(index, { documentTypeId: value });
              }}
            >
              <SelectTrigger id={`role-type-${String(index)}`}>
                <SelectValue placeholder="Selecione" />
              </SelectTrigger>
              <SelectContent>
                {options.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor={`role-card-${String(index)}`}>Quantidade</Label>
            <Select
              value={row.cardinality}
              disabled={disabled}
              onValueChange={(value) => {
                update(index, { cardinality: value === "many" ? "many" : "one" });
              }}
            >
              <SelectTrigger id={`role-card-${String(index)}`} className="w-[8rem]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="one">Um</SelectItem>
                <SelectItem value="many">Vários</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <label className="flex items-center gap-2 pb-2 text-[length:var(--fs-body-sm)]">
            <Checkbox
              checked={row.required}
              disabled={disabled}
              onCheckedChange={(checked) => {
                update(index, { required: checked === true });
              }}
            />
            Obrigatório
          </label>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-label="Remover papel"
            onClick={() => {
              onChange(rows.filter((_, i) => i !== index));
            }}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      ))}

      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => {
            onChange([...rows, { ...EMPTY_ROLE }]);
          }}
        >
          Adicionar papel
        </Button>
        <p className="mt-2 text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
          O nome do papel vira o caminho no modelo — <code>{"{{nota.numero}}"}</code>. Use apenas
          letras minúsculas, números e <code>_</code>. Um papel obrigatório sem documento deixa o
          relatório em “aguardando”.
        </p>
      </div>
    </div>
  );
}
