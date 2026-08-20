// Shared table for tenant-extensible LOV parameter pages (payment methods,
// future: categories, etc). Renders system + tenant rows in one merged view:
//   - System rows: read-only, "Sistema" badge in the Origin column.
//   - Tenant rows: full Edit / Inativar / Reativar actions.
//
// Pages that have extra columns (CategoriesPage will need DRE group etc.)
// can pass an `extraColumns` slot — header + per-row cells. Keeps the
// shared component agnostic of any single page's domain.

import type { ReactElement, ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export type LovParameterRow = {
  id: string;
  name: string;
  deletedAt: string | null;
  isSystem: boolean;
};

export type ExtraColumn<R extends LovParameterRow> = {
  key: string;
  header: ReactNode;
  cell: (row: R) => ReactNode;
  className?: string;
};

type Props<R extends LovParameterRow> = {
  rows: R[];
  isLoading: boolean;
  emptyMessage: string;
  showInactive: boolean;
  onEdit: (row: R) => void;
  onDeactivate: (row: R) => void;
  onRestore: (row: R) => void;
  isRestoring: boolean;
  extraColumns?: ExtraColumn<R>[];
};

export function LovParameterTable<R extends LovParameterRow>({
  rows,
  isLoading,
  emptyMessage,
  showInactive,
  onEdit,
  onDeactivate,
  onRestore,
  isRestoring,
  extraColumns = [],
}: Props<R>): ReactElement {
  if (isLoading) {
    return (
      <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">Carregando…</p>
    );
  }
  if (rows.length === 0) {
    return (
      <p className="py-10 text-[length:var(--fs-body-sm)] italic text-[color:var(--ink-mute)]">
        {emptyMessage}
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Nome</TableHead>
          {extraColumns.map((c) => (
            <TableHead key={c.key} className={c.className}>
              {c.header}
            </TableHead>
          ))}
          <TableHead>Origem</TableHead>
          <TableHead>Situação</TableHead>
          <TableHead className="w-[1%] whitespace-nowrap text-right">Ações</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => {
          const inactive = r.deletedAt !== null;
          return (
            <TableRow key={r.id}>
              <TableCell className="font-[500] text-[color:var(--ink)]">{r.name}</TableCell>
              {extraColumns.map((c) => (
                <TableCell key={c.key} className={c.className}>
                  {c.cell(r)}
                </TableCell>
              ))}
              <TableCell>
                {r.isSystem ? (
                  <Badge variant="accent">Sistema</Badge>
                ) : (
                  <Badge variant="outline">Personalizado</Badge>
                )}
              </TableCell>
              <TableCell>
                {inactive ? (
                  <Badge variant="secondary">Inativa</Badge>
                ) : (
                  <Badge variant="success">Ativa</Badge>
                )}
              </TableCell>
              <TableCell className="text-right">
                {r.isSystem ? (
                  <span className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
                    —
                  </span>
                ) : showInactive ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      onRestore(r);
                    }}
                    disabled={isRestoring}
                  >
                    Reativar
                  </Button>
                ) : (
                  <div className="flex justify-end gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        onEdit(r);
                      }}
                    >
                      Editar
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        onDeactivate(r);
                      }}
                    >
                      Inativar
                    </Button>
                  </div>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
