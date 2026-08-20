import { useState, type ReactElement } from "react";
import { trpc } from "@/shared/lib/trpc";
import { AppLayout } from "@/components/layout/AppLayout";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

const ALL_TYPES = "__all__";

export function AdminLovCatalogPage(): ReactElement {
  const [type, setType] = useState<string>(ALL_TYPES);
  const [includeDeleted, setIncludeDeleted] = useState<boolean>(true);

  const typesQuery = trpc.adminLov.listAllTypes.useQuery();
  const rowsQuery = trpc.adminLov.listAll.useQuery({
    type: type === ALL_TYPES ? undefined : type,
    includeDeleted,
  });

  const error = typesQuery.error ?? rowsQuery.error;
  if (error) {
    return (
      <AppLayout>
        <div className="mx-auto max-w-[1400px] px-6 py-10">
          <h1 className="text-2xl font-semibold">Catálogo LOV (debug)</h1>
          <p className="mt-4 text-sm text-muted-foreground">
            {error.data?.code === "FORBIDDEN"
              ? "Esta página é restrita a administradores."
              : error.message}
          </p>
        </div>
      </AppLayout>
    );
  }

  const rows = rowsQuery.data ?? [];
  const types = typesQuery.data ?? [];

  return (
    <AppLayout>
      <div className="mx-auto max-w-[1400px] px-6 py-10">
        <h1 className="text-2xl font-semibold">Catálogo LOV (debug)</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Lista as linhas SISTEMA de <code>list_of_values</code> (tenant_id nulo, todos os tipos).
          Ferramenta temporária de admin para diagnosticar o catálogo global — não mostra linhas de
          nenhuma conta (decisions §2: admin de plataforma nunca lê linhas de outro tenant).
        </p>

        <div className="mt-6 flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="type">Tipo</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger id="type" className="w-[260px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_TYPES}>Todos</SelectItem>
                {types.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <label className="flex items-center gap-2 pb-2 text-sm">
            <Checkbox
              checked={includeDeleted}
              onCheckedChange={(v) => {
                setIncludeDeleted(v === true);
              }}
            />
            Incluir excluídos
          </label>

          <div className="ml-auto pb-2 text-sm text-muted-foreground">
            {rowsQuery.isLoading ? "Carregando…" : `${rows.length} linhas`}
          </div>
        </div>

        <div className="mt-6">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Tipo</TableHead>
                <TableHead>Código</TableHead>
                <TableHead>Valor</TableHead>
                <TableHead>Escopo</TableHead>
                <TableHead>Categoria</TableHead>
                <TableHead className="text-right">Ordem</TableHead>
                <TableHead>Excluído</TableHead>
                <TableHead>Descrição</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const isSystem = row.tenantId === null;
                const isDeleted = row.deletedAt !== null;
                return (
                  <TableRow key={row.id} className={cn(isDeleted && "opacity-60")}>
                    <TableCell className="font-mono text-xs">{row.type}</TableCell>
                    <TableCell className="font-mono text-xs">{row.code}</TableCell>
                    <TableCell className="font-medium">{row.value}</TableCell>
                    <TableCell>
                      <Badge variant={isSystem ? "accent" : "secondary"}>
                        {isSystem ? "Sistema" : "Cliente"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.category ?? "—"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{row.sortOrder ?? 0}</TableCell>
                    <TableCell>
                      {isDeleted ? (
                        <Badge variant="destructive">Sim</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">não</span>
                      )}
                    </TableCell>
                    <TableCell className="max-w-[320px] truncate text-xs text-muted-foreground">
                      {row.description ?? ""}
                    </TableCell>
                  </TableRow>
                );
              })}
              {rows.length === 0 && !rowsQuery.isLoading && (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-muted-foreground">
                    Nenhuma linha.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </AppLayout>
  );
}
