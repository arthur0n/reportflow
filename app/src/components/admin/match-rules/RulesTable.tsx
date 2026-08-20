import type { ReactElement } from "react";
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
import { cn } from "@/lib/utils";
import { ORIGIN_LABEL } from "./match-rule-shared";

export type RuleRow = {
  id: string;
  targetKind: string;
  pattern: string;
  matchKind: string;
  lovTargetId: string | null;
  tvTargetId: string | null;
  category: string | null;
  confidence: number;
  priority: number;
  origin: string;
  description: string | null;
  deletedAt: string | null;
};

type Props = {
  rows: RuleRow[];
  isLoading: boolean;
  showAudience: boolean;
  resolveTargetLabel: (rule: RuleRow) => string;
  onEdit: (rule: RuleRow) => void;
  onDeactivate: (id: string) => void;
  onRestore: (id: string) => void;
  isDeactivating: boolean;
  isRestoring: boolean;
};

export function RulesTable({
  rows,
  isLoading,
  showAudience,
  resolveTargetLabel,
  onEdit,
  onDeactivate,
  onRestore,
  isDeactivating,
  isRestoring,
}: Props): ReactElement {
  const colCount = showAudience ? 9 : 8;
  return (
    <div className="mt-6">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Destino</TableHead>
            <TableHead>Padrão</TableHead>
            <TableHead>Match</TableHead>
            <TableHead>Alvo</TableHead>
            {showAudience && <TableHead>Audiência</TableHead>}
            <TableHead className="text-right">Conf.</TableHead>
            <TableHead className="text-right">Prio.</TableHead>
            <TableHead>Origem</TableHead>
            <TableHead className="text-right">Ações</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((rule) => {
            const isDeleted = rule.deletedAt !== null;
            return (
              <TableRow key={rule.id} className={cn(isDeleted && "opacity-60")}>
                <TableCell>
                  <Badge variant="secondary">{rule.targetKind}</Badge>
                </TableCell>
                <TableCell className="max-w-[280px] truncate font-mono text-xs">
                  {rule.pattern}
                </TableCell>
                <TableCell className="text-xs uppercase">{rule.matchKind}</TableCell>
                <TableCell className="font-medium">{resolveTargetLabel(rule)}</TableCell>
                {showAudience && (
                  <TableCell className="text-xs text-muted-foreground">
                    {rule.category ?? "—"}
                  </TableCell>
                )}
                <TableCell className="text-right tabular-nums">{rule.confidence}</TableCell>
                <TableCell className="text-right tabular-nums">{rule.priority}</TableCell>
                <TableCell>
                  <Badge variant="outline">{ORIGIN_LABEL[rule.origin] ?? rule.origin}</Badge>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1.5">
                    {!isDeleted && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          onEdit(rule);
                        }}
                      >
                        Editar
                      </Button>
                    )}
                    {isDeleted ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={isRestoring}
                        onClick={() => {
                          onRestore(rule.id);
                        }}
                      >
                        Restaurar
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={isDeactivating}
                        onClick={() => {
                          onDeactivate(rule.id);
                        }}
                      >
                        Desativar
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
          {rows.length === 0 && !isLoading && (
            <TableRow>
              <TableCell colSpan={colCount} className="py-8 text-center text-muted-foreground">
                Nenhuma regra.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
