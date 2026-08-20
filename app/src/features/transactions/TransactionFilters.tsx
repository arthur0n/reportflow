import { useState, type ReactElement } from "react";
import { Filter, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { TrpcOutput } from "@/shared/lib/trpc";
import {
  type Filters,
  type SavedFilter,
  DEFAULT_FILTERS,
  deriveSelectOptions,
} from "./transaction-filters-utils";

type TxRow = TrpcOutput["transactions"]["list"][number];

function FilterFieldsGrid({
  draftFilters,
  setDraftFilters,
  typeOptions,
  statusOptions,
  categoryOptions,
  paymentMethodOptions,
  creditorOptions,
  cashBoxOptions,
  businessUnitOptions,
  subtypeOptions,
}: {
  draftFilters: Filters;
  setDraftFilters: (filters: Filters) => void;
  typeOptions: string[];
  statusOptions: string[];
  categoryOptions: string[];
  paymentMethodOptions: string[];
  creditorOptions: string[];
  cashBoxOptions: string[];
  businessUnitOptions: string[];
  subtypeOptions: string[];
}): ReactElement {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="flex flex-col gap-1.5">
        <Label className="text-[length:var(--fs-eyebrow)] uppercase tracking-wide text-[color:var(--ink-mute)]">
          Período de
        </Label>
        <Input
          type="date"
          value={draftFilters.periodFrom}
          onChange={(e) => {
            setDraftFilters({ ...draftFilters, periodFrom: e.target.value });
          }}
          className="h-8"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label className="text-[length:var(--fs-eyebrow)] uppercase tracking-wide text-[color:var(--ink-mute)]">
          Período até
        </Label>
        <Input
          type="date"
          value={draftFilters.periodTo}
          onChange={(e) => {
            setDraftFilters({ ...draftFilters, periodTo: e.target.value });
          }}
          className="h-8"
        />
      </div>
      <SelectField
        label="Tipo de lançamento"
        value={draftFilters.transactionType}
        options={typeOptions}
        onChange={(val) => {
          setDraftFilters({ ...draftFilters, transactionType: val });
        }}
      />
      <SelectField
        label="Status"
        value={draftFilters.status}
        options={statusOptions}
        onChange={(val) => {
          setDraftFilters({ ...draftFilters, status: val });
        }}
      />
      <SelectField
        label="Categoria"
        value={draftFilters.category}
        options={categoryOptions}
        onChange={(val) => {
          setDraftFilters({ ...draftFilters, category: val });
        }}
      />
      <SelectField
        label="Forma de pagamento"
        value={draftFilters.paymentMethod}
        options={paymentMethodOptions}
        onChange={(val) => {
          setDraftFilters({ ...draftFilters, paymentMethod: val });
        }}
      />
      <SelectField
        label="Credor (forn./cli.)"
        value={draftFilters.creditor}
        options={creditorOptions}
        onChange={(val) => {
          setDraftFilters({ ...draftFilters, creditor: val });
        }}
      />
      <SelectField
        label="Caixa"
        value={draftFilters.cashBox}
        options={cashBoxOptions}
        onChange={(val) => {
          setDraftFilters({ ...draftFilters, cashBox: val });
        }}
      />
      <SelectField
        label="Unidade de negócio"
        value={draftFilters.businessUnit}
        options={businessUnitOptions}
        onChange={(val) => {
          setDraftFilters({ ...draftFilters, businessUnit: val });
        }}
      />
      <SelectField
        label="Subtipo"
        value={draftFilters.subtype}
        options={subtypeOptions}
        onChange={(val) => {
          setDraftFilters({ ...draftFilters, subtype: val });
        }}
      />
      <div className="flex flex-col gap-1.5">
        <Label className="text-[length:var(--fs-eyebrow)] uppercase tracking-wide text-[color:var(--ink-mute)]">
          Descrição contém
        </Label>
        <Input
          value={draftFilters.descriptionContains}
          onChange={(e) => {
            setDraftFilters({ ...draftFilters, descriptionContains: e.target.value });
          }}
          placeholder="Digite para filtrar"
          className="h-8"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label className="text-[length:var(--fs-eyebrow)] uppercase tracking-wide text-[color:var(--ink-mute)]">
          Referência contém
        </Label>
        <Input
          value={draftFilters.referenceContains}
          onChange={(e) => {
            setDraftFilters({ ...draftFilters, referenceContains: e.target.value });
          }}
          placeholder="Digite para filtrar"
          className="h-8"
        />
      </div>
    </div>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (val: string) => void;
}): ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-[length:var(--fs-eyebrow)] uppercase tracking-wide text-[color:var(--ink-mute)]">
        {label}
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="">Todos</SelectItem>
          {options.map((opt) => (
            <SelectItem key={opt} value={opt}>
              {opt}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function SavedFiltersSection({
  savedFilters,
  showSavePrompt,
  saveName,
  onShowSavePrompt,
  onSaveName,
  onSaveFilter,
  onLoadFilter,
  onDeleteFilter,
}: {
  savedFilters: SavedFilter[];
  showSavePrompt: boolean;
  saveName: string;
  onShowSavePrompt: (show: boolean) => void;
  onSaveName: (name: string) => void;
  onSaveFilter: () => void;
  onLoadFilter: (filter: SavedFilter) => void;
  onDeleteFilter: (id: string) => void;
}): ReactElement {
  return (
    <div className="flex flex-col gap-2 pb-2 border-b border-[color:var(--rule)]">
      <div className="flex items-center justify-between">
        <span className="text-[length:var(--fs-eyebrow)] uppercase tracking-wide text-[color:var(--ink-mute)]">
          Meus filtros
        </span>
        {!showSavePrompt && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onShowSavePrompt(true);
            }}
            className="h-6 text-[length:var(--fs-body-sm)]"
          >
            Salvar atual
          </Button>
        )}
      </div>
      {showSavePrompt && (
        <div className="flex gap-2">
          <Input
            placeholder="Nome do filtro"
            value={saveName}
            onChange={(e) => {
              onSaveName(e.target.value);
            }}
            className="h-8"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                onSaveFilter();
              }
            }}
          />
          <Button size="sm" onClick={onSaveFilter} className="h-8">
            Salvar
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              onShowSavePrompt(false);
              onSaveName("");
            }}
            className="h-8"
          >
            Cancelar
          </Button>
        </div>
      )}
      {!showSavePrompt && savedFilters.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {savedFilters.map((filter) => (
            <div key={filter.id} className="relative">
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  onLoadFilter(filter);
                }}
                className="pr-7"
              >
                {filter.name}
              </Button>
              <button
                type="button"
                onClick={() => {
                  onDeleteFilter(filter.id);
                }}
                className="absolute right-1 top-1/2 -translate-y-1/2 text-[color:var(--ink-mute)] hover:text-[color:var(--ink)]"
                aria-label={`Deletar filtro ${filter.name}`}
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}
      {!showSavePrompt && savedFilters.length === 0 && (
        <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
          Nenhum filtro salvo ainda.
        </p>
      )}
    </div>
  );
}

export function FiltrosButton({
  rows,
  appliedFilters,
  onApplyFilters,
  savedFilters,
  onSavedFiltersChange,
}: {
  rows: TxRow[];
  appliedFilters: Filters;
  onApplyFilters: (filters: Filters) => void;
  savedFilters: SavedFilter[];
  onSavedFiltersChange: (filters: SavedFilter[]) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [draftFilters, setDraftFilters] = useState<Filters>(appliedFilters);
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [saveName, setSaveName] = useState("");

  const activeFilterCount = Object.values(appliedFilters).filter((v) => v !== "").length;

  const typeOptions = deriveSelectOptions(rows, (r) => r.transactionTypeCode);
  const statusOptions = deriveSelectOptions(rows, (r) => r.statusCode);
  const categoryOptions = deriveSelectOptions(rows, (r) => r.categoryLabel);
  const paymentMethodOptions = deriveSelectOptions(rows, (r) => r.paymentMethodLabel);
  const creditorOptions = deriveSelectOptions(rows, (r) => r.creditorLabel);
  const cashBoxOptions = deriveSelectOptions(rows, (r) => r.cashBoxLabel);
  const businessUnitOptions = deriveSelectOptions(rows, (r) => r.businessUnitLabel);
  const subtypeOptions = deriveSelectOptions(rows, (r) => r.subtypeLabel);

  function handleOpenChange(nextOpen: boolean): void {
    if (nextOpen) {
      setDraftFilters(appliedFilters);
    }
    setOpen(nextOpen);
  }

  function handleApply(): void {
    onApplyFilters(draftFilters);
    setOpen(false);
  }

  function handleClear(): void {
    setDraftFilters(DEFAULT_FILTERS);
  }

  function handleSaveFilter(): void {
    if (saveName.trim() === "") return;
    const newFilter: SavedFilter = {
      id: Date.now().toString(),
      name: saveName,
      filters: draftFilters,
    };
    const updated = [...savedFilters, newFilter];
    onSavedFiltersChange(updated);
    setSaveName("");
    setShowSavePrompt(false);
  }

  function handleLoadFilter(filter: SavedFilter): void {
    setDraftFilters(filter.filters);
    onApplyFilters(filter.filters);
    setOpen(false);
  }

  function handleDeleteFilter(id: string): void {
    const updated = savedFilters.filter((f) => f.id !== id);
    onSavedFiltersChange(updated);
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Filter className="mr-1 h-4 w-4" />
          Filtros {activeFilterCount > 0 && `(${activeFilterCount})`}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[520px]">
        <div className="flex flex-col gap-3">
          <Eyebrow>Filtros</Eyebrow>

          <SavedFiltersSection
            savedFilters={savedFilters}
            showSavePrompt={showSavePrompt}
            saveName={saveName}
            onShowSavePrompt={setShowSavePrompt}
            onSaveName={setSaveName}
            onSaveFilter={handleSaveFilter}
            onLoadFilter={handleLoadFilter}
            onDeleteFilter={handleDeleteFilter}
          />

          <FilterFieldsGrid
            draftFilters={draftFilters}
            setDraftFilters={setDraftFilters}
            typeOptions={typeOptions}
            statusOptions={statusOptions}
            categoryOptions={categoryOptions}
            paymentMethodOptions={paymentMethodOptions}
            creditorOptions={creditorOptions}
            cashBoxOptions={cashBoxOptions}
            businessUnitOptions={businessUnitOptions}
            subtypeOptions={subtypeOptions}
          />
          <div className="flex justify-end gap-2 pt-2 border-t border-[color:var(--rule)]">
            <Button variant="ghost" size="sm" onClick={handleClear}>
              Limpar
            </Button>
            <Button size="sm" onClick={handleApply}>
              Aplicar
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
