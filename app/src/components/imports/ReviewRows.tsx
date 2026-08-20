// Review-screen list for parsed import rows. Two collapsible sections: the
// reviewable section (delegated to ReviewableSection) drives per-row picker
// UI; the "Revisadas" section is a read-only summary. Mutations bubble back
// through onInvalidate so we refresh both the rows list and the parent
// import for status counts.

import { type ReactElement } from "react";
import { ChevronRight } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { trpc } from "@/shared/lib/trpc";
import { formatDate } from "@/shared/lib/format";
import { useLov } from "@/hooks/use-lov";
import { ReviewableSection } from "./ReviewableSection";
import { centsToReais, signedAmountClass } from "./review-rows-helpers";
import type { ImportRowData } from "./ReviewableRow";

export type { ImportRowData };

export function ReviewRows({
  reviewableRows,
  reviewedRows,
}: {
  reviewableRows: ImportRowData[];
  reviewedRows: ImportRowData[];
}): ReactElement {
  const utils = trpc.useUtils();
  const rowStatusLov = useLov("STATEMENT_IMPORT_ROW_STATUS");

  const invalidateRows = (): void => {
    void utils.statementImportRows.list.invalidate();
    void utils.statementImports.get.invalidate();
  };

  return (
    <>
      {reviewableRows.length > 0 && (
        <ReviewableSection rows={reviewableRows} onInvalidate={invalidateRows} />
      )}

      {reviewedRows.length > 0 && (
        <Collapsible className="mt-6">
          <CollapsibleTrigger className="group flex items-center gap-2 mb-3 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]">
            <ChevronRight className="h-3.5 w-3.5 text-[color:var(--ink-mute)] transition-transform duration-200 group-data-[state=open]:rotate-90" />
            <span className="text-[length:var(--fs-eyebrow)] uppercase tracking-[0.14em] font-[550] text-[color:var(--ink)]">
              Revisadas
            </span>
            <span className="tabular-nums text-[length:var(--fs-eyebrow)] text-[color:var(--ink-mute)]">
              · {reviewedRows.length}
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Data</TableHead>
                  <TableHead className="text-right">Valor</TableHead>
                  <TableHead>Descrição</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reviewedRows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="text-[length:var(--fs-eyebrow)] text-[color:var(--ink-mute)] tabular-nums">
                      {String(row.lineNumber).padStart(3, "0")}
                    </TableCell>
                    <TableCell className="tabular-nums text-[color:var(--ink-soft)]">
                      {formatDate(row.actualDate)}
                    </TableCell>
                    <TableCell
                      className={`text-right tabular-nums ${signedAmountClass(row.actualAmount)}`}
                    >
                      {centsToReais(row.actualAmount)}
                    </TableCell>
                    <TableCell className="max-w-[280px] truncate text-[color:var(--ink-soft)]">
                      {row.description}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        {rowStatusLov.label(row.status, row.status)}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CollapsibleContent>
        </Collapsible>
      )}
    </>
  );
}
