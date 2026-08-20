import { useMemo, useState, type ReactElement } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Rule } from "@/components/ui/rule";
import { trpc, type TrpcOutput } from "@/shared/lib/trpc";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { CreateCategoryDialog } from "@/features/categories/CreateCategoryDialog";
import {
  EditCategoryDialog,
  type EditableCategory,
} from "@/features/categories/EditCategoryDialog";
import {
  ReclassifyCategoryDialog,
  type ReclassifiableCategory,
} from "@/features/categories/ReclassifyCategoryDialog";
import {
  DeactivateConfirmDialog,
  type DeactivableCategory,
} from "@/features/categories/DeactivateConfirmDialog";

type Category = TrpcOutput["categories"]["list"][number];
type DreGroup = TrpcOutput["dreGroups"]["list"][number];

export function CategoriesPage(): ReactElement {
  const utils = trpc.useUtils();
  const listQuery = trpc.categories.list.useQuery({ status: "all" });
  const dreGroupsQuery = trpc.dreGroups.list.useQuery();

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<EditableCategory | null>(null);
  const [reclassTarget, setReclassTarget] = useState<ReclassifiableCategory | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<DeactivableCategory | null>(null);

  const restore = trpc.categories.restore.useMutation({
    onSuccess: () => {
      void utils.categories.list.invalidate();
      toast.success("Categoria restaurada.");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const dreGroupsByCode = useMemo(() => {
    const map = new Map<string, DreGroup>();
    for (const g of dreGroupsQuery.data ?? []) map.set(g.code, g);
    return map;
  }, [dreGroupsQuery.data]);

  const grouped = useMemo(() => {
    const map = new Map<string, Category[]>();
    for (const c of listQuery.data ?? []) {
      const code = c.dreGroup.code;
      const arr = map.get(code) ?? [];
      arr.push(c);
      map.set(code, arr);
    }
    const entries = Array.from(map.entries());
    entries.sort((a, b) => {
      const oa = dreGroupsByCode.get(a[0])?.sortOrder ?? 99;
      const ob = dreGroupsByCode.get(b[0])?.sortOrder ?? 99;
      return oa - ob;
    });
    return entries;
  }, [listQuery.data, dreGroupsByCode]);

  return (
    <AppLayout>
      <PageHeader
        eyebrow="Plano de contas (DRE)"
        title="Categorias"
        lede="Seu plano de contas, organizado por grupo do DRE."
        aside={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setCreateOpen(true);
            }}
          >
            Nova categoria
          </Button>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-x-10 gap-y-8">
        <div className="lg:col-span-8 flex flex-col gap-10">
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
          {listQuery.data?.length === 0 && (
            <div className="py-16 flex flex-col items-center gap-3 text-center">
              <Eyebrow>Plano vazio</Eyebrow>
              <p className="font-serif text-[length:var(--fs-display)] font-[400] italic leading-[1.1] text-[color:var(--ink-soft)] max-w-md">
                Nenhuma categoria cadastrada.
              </p>
              <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)] max-w-md">
                Comece criando sua primeira categoria.
              </p>
            </div>
          )}

          {grouped.map(([code, cats]) => {
            const meta = dreGroupsByCode.get(code);
            const label = meta?.label ?? code;
            return (
              <section key={code} className="flex flex-col gap-3">
                <header className="flex items-baseline gap-4">
                  <span className="font-serif italic text-[1.25rem] font-[500] text-[color:var(--accent)] tabular-nums">
                    {code}
                  </span>
                  <h2 className="font-serif text-[length:var(--fs-section)] font-[500] leading-[1.1] tracking-[-0.012em]">
                    {label}
                  </h2>
                  <span className="ml-auto text-[length:var(--fs-eyebrow)] uppercase tracking-[0.12em] font-[550] text-[color:var(--ink-mute)] tabular-nums">
                    {cats.length}
                  </span>
                </header>
                <Rule strong />
                <ul className="flex flex-col">
                  {cats.map((c) => {
                    const isInactive = c.deletedAt !== null;
                    return (
                      <li
                        key={c.id}
                        className={cn(
                          "grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-6 py-2.5",
                          "border-b border-[color:var(--rule)] last:border-b-0",
                          isInactive && "opacity-60",
                        )}
                      >
                        <div className="flex flex-col min-w-0">
                          <span
                            className={cn(
                              "text-[length:var(--fs-body)] font-[450] text-[color:var(--ink)] truncate",
                              isInactive && "italic",
                            )}
                          >
                            {c.name}
                          </span>
                          {c.description !== null && c.description.length > 0 && (
                            <span className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)] truncate">
                              {c.description}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1">
                          {isInactive ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                restore.mutate(c.id);
                              }}
                              disabled={restore.isPending}
                            >
                              Restaurar
                            </Button>
                          ) : (
                            <>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setEditTarget({
                                    id: c.id,
                                    name: c.name,
                                    description: c.description,
                                  });
                                }}
                              >
                                Editar
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setReclassTarget({
                                    id: c.id,
                                    name: c.name,
                                    currentDreGroupCode: c.dreGroup.code,
                                  });
                                }}
                              >
                                Reclassificar
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  setDeactivateTarget({ id: c.id, name: c.name });
                                }}
                              >
                                Inativar
                              </Button>
                            </>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>

        <aside className="lg:col-span-4 lg:pl-6 lg:border-l lg:border-[color:var(--rule)]">
          <div className="sticky top-32 flex flex-col gap-3">
            <Eyebrow>Grupos DRE</Eyebrow>
            <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)]">
              Códigos do sistema que organizam o DRE. Não editáveis pelo tenant.
            </p>
            <Rule />
            <dl className="flex flex-col gap-0">
              {(dreGroupsQuery.data ?? []).map((g) => (
                <div
                  key={g.id}
                  className="grid grid-cols-[3rem_minmax(0,1fr)] items-baseline gap-3 py-2 border-b border-[color:var(--rule)] last:border-b-0"
                >
                  <dt className="font-serif italic text-[color:var(--accent)] font-[500] text-[0.9375rem]">
                    {g.code}
                  </dt>
                  <dd className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)]">
                    {g.label}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </aside>
      </div>

      <CreateCategoryDialog open={createOpen} onOpenChange={setCreateOpen} />
      <EditCategoryDialog
        category={editTarget}
        open={editTarget !== null}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
      />
      <ReclassifyCategoryDialog
        category={reclassTarget}
        open={reclassTarget !== null}
        onOpenChange={(open) => {
          if (!open) setReclassTarget(null);
        }}
      />
      <DeactivateConfirmDialog
        category={deactivateTarget}
        open={deactivateTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeactivateTarget(null);
        }}
      />
    </AppLayout>
  );
}
