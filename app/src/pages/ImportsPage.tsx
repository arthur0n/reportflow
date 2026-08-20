import type { ReactElement } from "react";
import { Link } from "wouter";
import { ArrowRight, Building2, CreditCard } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { ImportStatusBadge } from "@/components/imports/ImportStatusBadge";
import { Badge } from "@/components/ui/badge";
import { Eyebrow } from "@/components/ui/eyebrow";
import { useLov } from "@/hooks/use-lov";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { trpc } from "@/shared/lib/trpc";
import { formatDate } from "@/shared/lib/format";

// Entry card into one side of the import flow. Each side is standalone —
// matching re-runs whenever either lands, so there is no forced order.
function ImportEntryCard({
  href,
  icon,
  title,
  description,
}: {
  href: string;
  icon: ReactElement;
  title: string;
  description: string;
}): ReactElement {
  return (
    <Link
      href={href}
      className="group flex flex-col gap-2 rounded-[var(--radius-md)] border border-[color:var(--rule-strong)] bg-[color:var(--paper-sink)]/40 p-5 transition-colors hover:bg-[color:var(--paper-sink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)]"
    >
      <span className="flex items-center gap-2 text-[color:var(--ink-mute)]">{icon}</span>
      <span className="font-serif text-[length:var(--fs-section)] font-[500] tracking-[-0.01em] text-[color:var(--ink)]">
        {title}
      </span>
      <span className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)]">
        {description}
      </span>
      <span className="mt-1 inline-flex items-center gap-1.5 text-[length:var(--fs-body-sm)] font-[550] text-[color:var(--accent)] group-hover:underline">
        Enviar arquivo <ArrowRight className="h-3.5 w-3.5" />
      </span>
    </Link>
  );
}

export function ImportsPage(): ReactElement {
  const sourceKindLov = useLov("STATEMENT_IMPORT_SOURCE_KIND");
  const listQuery = trpc.statementImports.list.useQuery(undefined, {
    refetchInterval: (query) => {
      const items = query.state.data?.items;
      if (!items) return false;
      const hasInProgress = items.some((i) => ["uploaded_pending", "parsing"].includes(i.status));
      return hasInProgress ? 2000 : false;
    },
  });

  return (
    <AppLayout>
      <PageHeader
        eyebrow="Entrada de dados"
        title="Importações"
        lede="Envie o extrato do banco e as vendas da adquirente — em qualquer ordem."
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ImportEntryCard
          href="/imports/bank"
          icon={<Building2 className="h-4.5 w-4.5" aria-hidden="true" />}
          title="Extrato do banco"
          description="Arquivo OFX exportado do internet banking."
        />
        <ImportEntryCard
          href="/imports/acquirer"
          icon={<CreditCard className="h-4.5 w-4.5" aria-hidden="true" />}
          title="Vendas da adquirente"
          description="Relatório detalhado de vendas em CSV — a adquirente é detectada pelo arquivo."
        />
      </div>

      <section className="flex flex-col gap-3 pt-4">
        <div className="flex items-baseline justify-between gap-3">
          <Eyebrow>Histórico</Eyebrow>
          {listQuery.data && listQuery.data.items.length > 0 && (
            <span className="text-[length:var(--fs-eyebrow)] uppercase tracking-[0.12em] font-[550] text-[color:var(--ink-mute)] tabular-nums">
              {listQuery.data.items.length} arquivo{listQuery.data.items.length === 1 ? "" : "s"}
            </span>
          )}
        </div>

        {listQuery.isLoading && (
          <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
            Carregando…
          </p>
        )}
        {listQuery.error && (
          <p className="text-[length:var(--fs-body-sm)] text-[color:var(--negative)]">
            Erro: {listQuery.error.message}
          </p>
        )}
        {listQuery.data?.items.length === 0 && (
          <div className="py-10 text-center">
            <p className="font-serif text-[length:var(--fs-section)] font-[400] italic text-[color:var(--ink-soft)]">
              Nenhuma importação ainda.
            </p>
            <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)] mt-1">
              Envie um arquivo OFX acima para começar.
            </p>
          </div>
        )}
        {listQuery.data && listQuery.data.items.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Arquivo</TableHead>
                <TableHead>Origem</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Linhas</TableHead>
                <TableHead className="text-right">Erros</TableHead>
                <TableHead className="text-right">Duplicadas</TableHead>
                <TableHead>Enviado em</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {listQuery.data.items.map((imp) => (
                <TableRow key={imp.id}>
                  <TableCell>
                    <Link
                      href={`/imports/${imp.id}`}
                      className="font-serif text-[1.0625rem] font-[500] tracking-[-0.008em] text-[color:var(--ink)] hover:text-[color:var(--accent)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] rounded-sm"
                    >
                      {imp.fileName}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">
                      {sourceKindLov.label(imp.sourceKind, imp.sourceKind)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <ImportStatusBadge status={imp.status} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{imp.rowsTotal}</TableCell>
                  <TableCell
                    className={`text-right tabular-nums ${imp.rowsError > 0 ? "text-[color:var(--negative)] font-[500]" : "text-[color:var(--ink-mute)]"}`}
                  >
                    {imp.rowsError}
                  </TableCell>
                  <TableCell className="text-right tabular-nums text-[color:var(--ink-mute)]">
                    {imp.rowsDuplicate}
                  </TableCell>
                  <TableCell className="tabular-nums text-[color:var(--ink-soft)]">
                    {formatDate(imp.uploadedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </AppLayout>
  );
}
