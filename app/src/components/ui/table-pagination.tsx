import type { ReactElement } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  PAGE_SIZE_OPTIONS,
  isPageSize,
  type PageSize,
} from "@/hooks/use-pagination";

type Props = {
  page: number;
  pageSize: PageSize;
  totalRows: number;
  startIndex: number;
  endIndex: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: PageSize) => void;
};

export function TablePagination({
  page,
  pageSize,
  totalRows,
  startIndex,
  endIndex,
  totalPages,
  onPageChange,
  onPageSizeChange,
}: Props): ReactElement {
  const atStart = page <= 1;
  const atEnd = page >= totalPages;

  return (
    <div className="flex items-center justify-end gap-4 text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
      <div className="flex items-center gap-2">
        <span className="uppercase tracking-wide text-[length:var(--fs-eyebrow)]">
          Linhas por página
        </span>
        <Select
          value={String(pageSize)}
          onValueChange={(v) => {
            const n = Number(v);
            if (isPageSize(n)) onPageSizeChange(n);
          }}
        >
          <SelectTrigger className="h-7 w-[72px] px-2 py-0 text-[length:var(--fs-body-sm)]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZE_OPTIONS.map((s) => (
              <SelectItem key={s} value={String(s)}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <span className="tabular-nums">
        {totalRows === 0
          ? "Nenhum lançamento"
          : `${startIndex}–${endIndex} de ${totalRows}`}
      </span>

      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          disabled={atStart}
          aria-label="Página anterior"
          onClick={() => {
            onPageChange(page - 1);
          }}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          disabled={atEnd}
          aria-label="Próxima página"
          onClick={() => {
            onPageChange(page + 1);
          }}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
