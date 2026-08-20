// Per-field picker cell that lifts suggestion state out of ReviewableRow so
// adding another classification picker is one row of config, not another
// useState/useCallback/useMemo/JSX block.

import { useCallback, useState, type ReactElement } from "react";
import { InlineRefPicker, type PickerItem } from "@/components/inline-ref-picker";
import type { ResolveTarget } from "./ReviewableRow";

export type ClassificationFieldCellProps = {
  rowId: string;
  value: string | null;
  items: PickerItem[];
  target: ResolveTarget;
  description: string;
  placeholder: string;
  ariaLabel: string;
  fetchSuggestions: (
    rowId: string,
    target: ResolveTarget,
    candidate: string,
  ) => Promise<PickerItem[]>;
  onChange: (id: string | null) => void;
  onCreateRequested?: (name: string) => void;
  createSuggestion?: string;
};

export function ClassificationFieldCell({
  rowId,
  value,
  items,
  target,
  description,
  placeholder,
  ariaLabel,
  fetchSuggestions,
  onChange,
  onCreateRequested,
  createSuggestion,
}: ClassificationFieldCellProps): ReactElement {
  const [suggestions, setSuggestions] = useState<PickerItem[]>([]);

  const handleOpen = useCallback((): void => {
    if (description.length === 0) return;
    void fetchSuggestions(rowId, target, description).then(setSuggestions);
  }, [rowId, target, description, fetchSuggestions]);

  return (
    <InlineRefPicker
      value={value}
      items={items}
      suggestions={suggestions}
      onChange={onChange}
      onOpen={handleOpen}
      placeholder={placeholder}
      ariaLabel={ariaLabel}
      {...(onCreateRequested !== undefined ? { onCreateRequested } : {})}
      {...(createSuggestion !== undefined ? { createSuggestion } : {})}
    />
  );
}
