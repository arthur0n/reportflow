import { useMemo, useState, type ReactElement } from "react";
import { Check, ChevronDown, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";

/**
 * Compact, table-cell-friendly inline reference picker. Generic over PickerItem
 * so it serves any id-keyed selectable list (tenant_values, LOV rows, etc.).
 * onCreateRequested defers creation to the parent — typically opening a full
 * dialog with the typed name pre-filled — so the picker stays free of any
 * domain-specific create logic.
 */

export type PickerItem = {
  id: string;
  label: string;
  sublabel?: string;
  highlighted?: boolean;
};

export type InlineRefPickerProps = {
  value: string | null;
  items: PickerItem[];
  suggestions?: PickerItem[];
  onChange: (id: string | null) => void;
  /** Fires when the user clicks the "Criar X" affordance. The picker just
   *  closes the popover and forwards the typed name; the parent is expected
   *  to open a dialog (or otherwise create the entity) and update `value`
   *  through the normal data flow. */
  onCreateRequested?: (name: string) => void;
  /** Pre-filled name shown on the "Criar" item when the user has not typed.
   *  Lets the parent surface a derived suggestion (e.g. cleaned-up description)
   *  before the dialog opens, so the user knows what name will be created. */
  createSuggestion?: string;
  /** Fires once each time the popover transitions closed → open. Lets the parent
   *  lazy-fetch suggestions on demand instead of per render. */
  onOpen?: () => void;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
};

function matchesQuery(item: PickerItem, lowered: string): boolean {
  return (
    item.label.toLowerCase().includes(lowered) ||
    item.sublabel?.toLowerCase().includes(lowered) === true
  );
}

export function InlineRefPicker({
  value,
  items,
  suggestions = [],
  onChange,
  onCreateRequested,
  createSuggestion = "",
  onOpen,
  placeholder = "Selecionar…",
  disabled = false,
  ariaLabel,
}: InlineRefPickerProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const itemsById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const selected = value !== null ? (itemsById.get(value) ?? null) : null;
  const trimmed = query.trim();
  const lowered = trimmed.toLowerCase();

  const suggestionsToShow = useMemo(
    () =>
      suggestions.length === 0 || lowered.length === 0
        ? suggestions
        : suggestions.filter((s) => matchesQuery(s, lowered)),
    [suggestions, lowered],
  );

  const itemsToShow = useMemo(
    () => (lowered.length === 0 ? items : items.filter((i) => matchesQuery(i, lowered))),
    [items, lowered],
  );

  const exactMatch = useMemo(
    () =>
      items.find((i) => i.label.toLowerCase() === lowered) ??
      suggestions.find((s) => s.label.toLowerCase() === lowered) ??
      null,
    [items, suggestions, lowered],
  );

  const canOfferCreate = onCreateRequested !== undefined && exactMatch === null;

  function reset(): void {
    setQuery("");
  }

  function handleOpenChange(next: boolean): void {
    if (disabled) return;
    setOpen(next);
    if (next) onOpen?.();
    else reset();
  }

  function handleSelect(id: string): void {
    onChange(id);
    setOpen(false);
    reset();
  }

  const createName = trimmed.length > 0 ? trimmed : createSuggestion;

  function handleCreate(): void {
    if (onCreateRequested === undefined) return;
    onCreateRequested(createName);
    setOpen(false);
    reset();
  }

  return (
    <div className="inline-flex items-center gap-1 max-w-full">
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <PickerTrigger
            selected={selected}
            placeholder={placeholder}
            open={open}
            disabled={disabled}
            ariaLabel={ariaLabel}
          />
        </PopoverTrigger>
        <PopoverContent
          className="p-0 w-[--radix-popover-trigger-width] min-w-[260px]"
          align="start"
        >
          <Command shouldFilter={false}>
            <CommandInput value={query} onValueChange={setQuery} placeholder="Buscar…" />
            <PickerList
              value={value}
              suggestionsToShow={suggestionsToShow}
              itemsToShow={itemsToShow}
              canOfferCreate={canOfferCreate}
              createName={createName}
              onSelect={handleSelect}
              onCreate={handleCreate}
            />
          </Command>
        </PopoverContent>
      </Popover>
      {selected !== null && !disabled && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          aria-label="Limpar seleção"
          onClick={() => {
            onChange(null);
          }}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}

function PickerTrigger({
  selected,
  placeholder,
  open,
  disabled,
  ariaLabel,
  ...rest
}: {
  selected: PickerItem | null;
  placeholder: string;
  open: boolean;
  disabled: boolean;
  ariaLabel: string | undefined;
}): ReactElement {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      role="combobox"
      aria-expanded={open}
      aria-label={ariaLabel}
      disabled={disabled}
      className={cn(
        "justify-between font-normal normal-case tracking-normal max-w-full min-w-0",
        selected?.sublabel !== undefined && "h-auto py-1",
      )}
      {...rest}
    >
      <span className="flex flex-col min-w-0 items-start text-left">
        <span
          className={cn("truncate max-w-full", selected === null && "text-[color:var(--ink-mute)]")}
        >
          {selected !== null ? selected.label : placeholder}
        </span>
        {selected?.sublabel !== undefined && (
          <span className="truncate max-w-full text-[length:var(--fs-eyebrow)] text-[color:var(--ink-mute)]">
            {selected.sublabel}
          </span>
        )}
      </span>
      <ChevronDown className="opacity-60 shrink-0" />
    </Button>
  );
}

function PickerList({
  value,
  suggestionsToShow,
  itemsToShow,
  canOfferCreate,
  createName,
  onSelect,
  onCreate,
}: {
  value: string | null;
  suggestionsToShow: PickerItem[];
  itemsToShow: PickerItem[];
  canOfferCreate: boolean;
  createName: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
}): ReactElement {
  const empty = suggestionsToShow.length === 0 && itemsToShow.length === 0 && !canOfferCreate;
  return (
    <CommandList>
      {empty && <CommandEmpty>Nada encontrado.</CommandEmpty>}

      {suggestionsToShow.length > 0 && (
        <>
          <CommandGroup heading="Sugestões">
            {suggestionsToShow.map((s) => (
              <CommandItem
                key={`s-${s.id}`}
                value={`s-${s.id}`}
                onSelect={() => {
                  onSelect(s.id);
                }}
                className="bg-[color:var(--accent-wash)]/40 data-[selected=true]:bg-[color:var(--accent-wash)]"
              >
                <PickerRow item={s} selectedId={value} showSuggestionChip />
              </CommandItem>
            ))}
          </CommandGroup>
          {itemsToShow.length > 0 && <CommandSeparator />}
        </>
      )}

      {itemsToShow.length > 0 && (
        <CommandGroup heading={suggestionsToShow.length > 0 ? "Todos" : undefined}>
          {itemsToShow.map((i) => (
            <CommandItem
              key={i.id}
              value={i.id}
              onSelect={() => {
                onSelect(i.id);
              }}
            >
              <PickerRow item={i} selectedId={value} />
            </CommandItem>
          ))}
        </CommandGroup>
      )}

      {canOfferCreate && (
        <>
          {(suggestionsToShow.length > 0 || itemsToShow.length > 0) && <CommandSeparator />}
          <CommandGroup>
            <CommandItem value={`__create__:${createName}`} onSelect={onCreate}>
              <span className="truncate">
                {createName.length > 0 ? `Criar "${createName}"` : "Criar novo"}
              </span>
            </CommandItem>
          </CommandGroup>
        </>
      )}
    </CommandList>
  );
}

function PickerRow({
  item,
  selectedId,
  showSuggestionChip = false,
}: {
  item: PickerItem;
  selectedId: string | null;
  showSuggestionChip?: boolean;
}): ReactElement {
  const isSelected = selectedId === item.id;
  return (
    <div className="flex items-center gap-2 min-w-0 w-full">
      <Check className={cn("h-4 w-4 shrink-0", isSelected ? "opacity-100" : "opacity-0")} />
      <div className="flex flex-col min-w-0 flex-1">
        <span className="truncate text-[length:var(--fs-body-sm)]">{item.label}</span>
        {item.sublabel !== undefined && (
          <span className="truncate text-[length:var(--fs-eyebrow)] text-[color:var(--ink-mute)]">
            {item.sublabel}
          </span>
        )}
      </div>
      {showSuggestionChip && (
        <Badge variant="accent" className="ml-auto shrink-0">
          Sugestão
        </Badge>
      )}
    </div>
  );
}
