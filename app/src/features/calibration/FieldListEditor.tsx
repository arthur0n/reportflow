// app/src/features/calibration/FieldListEditor.tsx
//
// The "human edits" step of §3.1, and deliberately nothing more than a table.
// The field list is DATA (shared/validation/field-spec.ts), so editing it is
// editing rows: name, type, required, description — plus one level of nesting
// for the `object[]` that line items need, because a flat list cannot express
// `itens[].total`.
//
// No drag-and-drop, no inline validation theatre. Order matters (§3.1, "the
// ordered field list"), so there are ↑/↓ buttons; everything else the server's
// Zod input schema already decides, and it is the one that has to be right.

import { Fragment, type ReactElement } from "react";
import { Trash2, ChevronUp, ChevronDown, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FIELD_TYPES,
  LEAF_FIELD_TYPES,
  isContainerType,
  type FieldType,
  type LeafFieldType,
} from "@shared/validation/field-spec";

export type DraftChild = {
  name: string;
  type: LeafFieldType;
  required: boolean;
  description: string;
};

export type DraftField = {
  name: string;
  type: FieldType;
  required: boolean;
  description: string;
  fields?: DraftChild[] | undefined;
};

function moved<T>(list: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item === undefined) return [...list];
  next.splice(to, 0, item);
  return next;
}

const cellClass =
  "border-b border-[color:var(--rule)] px-2 py-1.5 align-top text-[length:var(--fs-body-sm)]";

function TypeSelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: readonly string[];
  onChange: (next: string) => void;
}): ReactElement {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-[130px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((t) => (
          <SelectItem key={t} value={t}>
            {t}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ChildRow({
  child,
  onChange,
  onRemove,
}: {
  child: DraftChild;
  onChange: (next: DraftChild) => void;
  onRemove: () => void;
}): ReactElement {
  return (
    <tr>
      <td className={cellClass}>
        <div className="flex items-center gap-1.5 pl-6">
          <span aria-hidden className="text-[color:var(--ink-mute)]">
            ↳
          </span>
          <Input
            value={child.name}
            onChange={(e) => {
              onChange({ ...child, name: e.target.value });
            }}
            aria-label="Nome do subcampo"
          />
        </div>
      </td>
      <td className={cellClass}>
        <TypeSelect
          value={child.type}
          options={LEAF_FIELD_TYPES}
          onChange={(next) => {
            onChange({ ...child, type: next as LeafFieldType });
          }}
        />
      </td>
      <td className={cellClass}>
        <Checkbox
          checked={child.required}
          onCheckedChange={(checked) => {
            onChange({ ...child, required: checked === true });
          }}
          aria-label="Subcampo obrigatório"
        />
      </td>
      <td className={cellClass}>
        <Input
          value={child.description}
          onChange={(e) => {
            onChange({ ...child, description: e.target.value });
          }}
          aria-label="Descrição do subcampo"
        />
      </td>
      <td className={cellClass}>
        <Button variant="ghost" size="sm" onClick={onRemove} aria-label="Remover subcampo">
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </td>
    </tr>
  );
}

export function FieldListEditor({
  fields,
  onChange,
}: {
  fields: DraftField[];
  onChange: (next: DraftField[]) => void;
}): ReactElement {
  const patch = (index: number, next: DraftField): void => {
    onChange(fields.map((f, i) => (i === index ? next : f)));
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse">
          <thead>
            <tr className="text-left text-[length:var(--fs-eyebrow)] uppercase tracking-[0.12em] text-[color:var(--ink-mute)]">
              <th className="px-2 pb-1.5">Nome</th>
              <th className="px-2 pb-1.5">Tipo</th>
              <th className="px-2 pb-1.5">Obrig.</th>
              <th className="px-2 pb-1.5">Descrição</th>
              <th className="px-2 pb-1.5" />
            </tr>
          </thead>
          <tbody>
            {fields.map((field, index) => (
              <Fragment key={`f-${String(index)}`}>
                <tr>
                  <td className={cellClass}>
                    <Input
                      value={field.name}
                      onChange={(e) => {
                        patch(index, { ...field, name: e.target.value });
                      }}
                      aria-label="Nome do campo"
                    />
                  </td>
                  <td className={cellClass}>
                    <TypeSelect
                      value={field.type}
                      options={FIELD_TYPES}
                      onChange={(next) => {
                        const type = next as FieldType;
                        patch(index, {
                          ...field,
                          type,
                          ...(isContainerType(type)
                            ? { fields: field.fields ?? [] }
                            : { fields: undefined }),
                        });
                      }}
                    />
                  </td>
                  <td className={cellClass}>
                    <Checkbox
                      checked={field.required}
                      onCheckedChange={(checked) => {
                        patch(index, { ...field, required: checked === true });
                      }}
                      aria-label="Campo obrigatório"
                    />
                  </td>
                  <td className={cellClass}>
                    <Input
                      value={field.description}
                      onChange={(e) => {
                        patch(index, { ...field, description: e.target.value });
                      }}
                      aria-label="Descrição do campo"
                    />
                  </td>
                  <td className={cellClass}>
                    <div className="flex items-center gap-0.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label="Subir"
                        onClick={() => {
                          onChange(moved(fields, index, index - 1));
                        }}
                      >
                        <ChevronUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label="Descer"
                        onClick={() => {
                          onChange(moved(fields, index, index + 1));
                        }}
                      >
                        <ChevronDown className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label="Remover campo"
                        onClick={() => {
                          onChange(fields.filter((_, i) => i !== index));
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>

                {(field.fields ?? []).map((child, childIndex) => (
                  <ChildRow
                    key={`f-${String(index)}-c-${String(childIndex)}`}
                    child={child}
                    onChange={(next) => {
                      patch(index, {
                        ...field,
                        fields: (field.fields ?? []).map((c, i) => (i === childIndex ? next : c)),
                      });
                    }}
                    onRemove={() => {
                      patch(index, {
                        ...field,
                        fields: (field.fields ?? []).filter((_, i) => i !== childIndex),
                      });
                    }}
                  />
                ))}

                {isContainerType(field.type) && (
                  <tr key={`f-${String(index)}-add`}>
                    <td className={cellClass} colSpan={5}>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-6"
                        onClick={() => {
                          patch(index, {
                            ...field,
                            fields: [
                              ...(field.fields ?? []),
                              { name: "", type: "string", required: true, description: "" },
                            ],
                          });
                        }}
                      >
                        <Plus className="h-3.5 w-3.5" /> Subcampo
                      </Button>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            onChange([...fields, { name: "", type: "string", required: true, description: "" }]);
          }}
        >
          <Plus className="h-3.5 w-3.5" /> Campo
        </Button>
      </div>
    </div>
  );
}
