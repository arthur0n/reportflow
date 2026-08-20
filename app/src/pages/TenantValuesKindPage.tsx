import { useMemo, useState, type ReactElement } from "react";
import { Redirect, useParams } from "wouter";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { trpc, type TrpcOutput } from "@/shared/lib/trpc";
import { useLov } from "@/hooks/use-lov";
import { toast } from "sonner";
import { TenantValueDialog } from "@/features/tenant-values/TenantValueDialog";
import {
  DeactivateTenantValueDialog,
  type DeactivableTenantValue,
} from "@/features/tenant-values/DeactivateTenantValueDialog";
import {
  kindFromUrlSlug,
  TENANT_VALUE_KIND_CONFIG,
  type TenantValueKind,
} from "@shared/constants/tenant-value-kinds";

type Row = TrpcOutput["tenantValues"]["list"][number];
type Tab = "ativos" | "inativos";

function isInactive(r: Row): boolean {
  return r.deletedAt !== null;
}

export function TenantValuesKindPage(): ReactElement {
  const params = useParams<{ slug: string }>();
  const kind = kindFromUrlSlug(params.slug);

  if (kind === null) {
    return <Redirect to="/dashboard" />;
  }
  return <TenantValuesKindView kind={kind} />;
}

function TenantValuesKindView({ kind }: { kind: TenantValueKind }): ReactElement {
  const cfg = TENANT_VALUE_KIND_CONFIG[kind];
  const utils = trpc.useUtils();
  const registry = useLov("TENANT_VALUES");
  const pluralLabel = registry.byCode.get(kind)?.value ?? cfg.labelOne;

  const listQuery = trpc.tenantValues.list.useQuery({ kind, status: "all" });
  const [tab, setTab] = useState<Tab>("ativos");
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Row | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<DeactivableTenantValue | null>(null);

  const restore = trpc.tenantValues.restore.useMutation({
    onSuccess: () => {
      void utils.tenantValues.invalidate();
      toast.success(`${cfg.labelOne} reativado.`);
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const all = useMemo(() => listQuery.data ?? [], [listQuery.data]);
  const filtered = useMemo(
    () => (tab === "ativos" ? all.filter((r) => !isInactive(r)) : all.filter((r) => isInactive(r))),
    [all, tab],
  );

  const tabs: { key: Tab; label: string; count: number }[] = useMemo(
    () => [
      { key: "ativos", label: "Ativos", count: all.filter((r) => !isInactive(r)).length },
      { key: "inativos", label: "Inativos", count: all.filter((r) => isInactive(r)).length },
    ],
    [all],
  );

  const showParentColumn = cfg.parent.source !== "none";
  const showBankColumn = kind === "CASH_BOX";

  return (
    <AppLayout>
      <PageHeader
        eyebrow="Cadastros"
        title={pluralLabel}
        aside={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setCreateOpen(true);
            }}
          >
            Novo {cfg.labelOne}
          </Button>
        }
      />

      <nav
        className="flex gap-6 border-b border-[color:var(--rule)] pb-3"
        aria-label={`Filtro de ${pluralLabel.toLowerCase()}`}
      >
        {tabs.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => {
                setTab(t.key);
              }}
              className={cn(
                "relative inline-flex items-baseline gap-1.5",
                "text-[length:var(--fs-eyebrow)] uppercase tracking-[0.14em] font-[550]",
                "pb-3 -mb-3 transition-colors",
                active
                  ? "text-[color:var(--ink)]"
                  : "text-[color:var(--ink-mute)] hover:text-[color:var(--ink-soft)]",
              )}
            >
              <span>{t.label}</span>
              <span className="tabular-nums text-[color:var(--ink-mute)]">{t.count}</span>
              {active && (
                <span
                  aria-hidden
                  className="absolute left-0 right-0 bottom-0 h-[2px] bg-[color:var(--accent)]"
                />
              )}
            </button>
          );
        })}
      </nav>

      {listQuery.isLoading && (
        <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">Carregando…</p>
      )}
      {listQuery.error && (
        <p className="text-[length:var(--fs-body-sm)] text-[color:var(--negative)]">
          Erro: {listQuery.error.message}
        </p>
      )}
      {!listQuery.isLoading && filtered.length === 0 && (
        <p className="py-10 text-[length:var(--fs-body-sm)] italic text-[color:var(--ink-mute)]">
          {tab === "inativos"
            ? `Nenhum ${cfg.labelOne.toLowerCase()} inativo.`
            : `Nenhum ${cfg.labelOne.toLowerCase()} cadastrado.`}
        </p>
      )}
      {filtered.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Nome</TableHead>
              {showParentColumn && <TableHead>{cfg.parentLabel}</TableHead>}
              {showBankColumn && <TableHead>Banco</TableHead>}
              <TableHead>Situação</TableHead>
              <TableHead className="w-[1%] whitespace-nowrap text-right">Ações</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((r) => {
              const inactive = isInactive(r);
              return (
                <TableRow key={r.id}>
                  <TableCell className="font-[500] text-[color:var(--ink)]">{r.name}</TableCell>
                  {showParentColumn && (
                    <TableCell>
                      {r.parent ? (
                        cfg.parent.source === "lov-system" ? (
                          <Badge variant="outline">{r.parent.label}</Badge>
                        ) : (
                          <span className="text-[color:var(--ink-soft)]">{r.parent.label}</span>
                        )
                      ) : (
                        <span className="text-[color:var(--ink-mute)] italic">—</span>
                      )}
                    </TableCell>
                  )}
                  {showBankColumn && (
                    <TableCell>
                      {r.bank ? (
                        <span className="text-[color:var(--ink-soft)]">{r.bank.label}</span>
                      ) : (
                        <span className="text-[color:var(--ink-mute)] italic">—</span>
                      )}
                    </TableCell>
                  )}
                  <TableCell>
                    {inactive ? (
                      <Badge variant="secondary">Inativo</Badge>
                    ) : (
                      <Badge variant="success">Ativo</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {inactive ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          restore.mutate(r.id);
                        }}
                        disabled={restore.isPending}
                      >
                        Reativar
                      </Button>
                    ) : (
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setEditTarget(r);
                          }}
                        >
                          Editar
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setDeactivateTarget({ id: r.id, name: r.name });
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
      )}

      <TenantValueDialog
        kind={kind}
        tenantValue={null}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
      <TenantValueDialog
        kind={kind}
        tenantValue={editTarget}
        open={editTarget !== null}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
      />
      <DeactivateTenantValueDialog
        kind={kind}
        tenantValue={deactivateTarget}
        open={deactivateTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeactivateTarget(null);
        }}
      />
    </AppLayout>
  );
}
