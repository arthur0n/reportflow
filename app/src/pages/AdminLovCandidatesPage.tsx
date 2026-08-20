import { useState, type ReactElement } from "react";
import { trpc } from "@/shared/lib/trpc";
import { toast } from "sonner";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const PROMOTABLE_TYPES = [
  { value: "PAYMENT_METHOD", label: "Formas de pagamento" },
  { value: "CATEGORY", label: "Categorias" },
] as const;

const AUDIENCE_OPTIONS = [
  { value: "__null__", label: "Genérico (visível a todos)" },
  { value: "restaurant", label: "Restaurante" },
] as const;

type Candidate = {
  id: string;
  tenantId: string | null;
  value: string;
  code: string;
  createdAt: string;
  crossTenantCount: number;
};

export function AdminLovCandidatesPage(): ReactElement {
  const utils = trpc.useUtils();
  const [type, setType] = useState<(typeof PROMOTABLE_TYPES)[number]["value"]>("PAYMENT_METHOD");
  const [promoteTarget, setPromoteTarget] = useState<Candidate | null>(null);
  const [audience, setAudience] = useState<string>("__null__");

  const candidatesQuery = trpc.adminLov.listPromotionCandidates.useQuery({ type });

  const promote = trpc.adminLov.promote.useMutation({
    onSuccess: () => {
      void utils.adminLov.listPromotionCandidates.invalidate();
      void utils.listOfValues.invalidate();
      toast.success("Promovido para sistema.");
      setPromoteTarget(null);
      setAudience("__null__");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  function confirmPromote(): void {
    if (!promoteTarget) return;
    promote.mutate({
      id: promoteTarget.id,
      category: audience === "__null__" ? null : audience,
    });
  }

  if (candidatesQuery.error) {
    return (
      <AppLayout>
        <div className="mx-auto max-w-[1200px] px-6 py-10">
          <h1 className="text-2xl font-semibold">Catálogo (admin)</h1>
          <p className="mt-4 text-sm text-muted-foreground">
            {candidatesQuery.error.data?.code === "FORBIDDEN"
              ? "Esta página é restrita a administradores."
              : candidatesQuery.error.message}
          </p>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="mx-auto max-w-[1200px] px-6 py-10">
        <h1 className="text-2xl font-semibold">Catálogo (admin) — candidatos a sistema</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Linhas criadas por tenants, ordenadas por frequência cruzada e idade. Promover gira o
          tenant_id para NULL e mantém o id da linha (FKs em transactions continuam apontando).
        </p>

        <div className="mt-6 flex items-end gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="type">Tipo</Label>
            <Select
              value={type}
              onValueChange={(v) => {
                setType(v as (typeof PROMOTABLE_TYPES)[number]["value"]);
              }}
            >
              <SelectTrigger id="type" className="w-[280px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROMOTABLE_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="mt-6 overflow-hidden rounded border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr className="text-left">
                <th className="px-4 py-2">Valor</th>
                <th className="px-4 py-2">Código</th>
                <th className="px-4 py-2">Clientes</th>
                <th className="px-4 py-2">Criado em</th>
                <th className="px-4 py-2 text-right">Ação</th>
              </tr>
            </thead>
            <tbody>
              {(candidatesQuery.data ?? []).map((row) => (
                <tr key={row.id} className="border-t">
                  <td className="px-4 py-2 font-medium">{row.value}</td>
                  <td className="px-4 py-2 font-mono text-xs">{row.code}</td>
                  <td className="px-4 py-2">{row.crossTenantCount}</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {new Date(row.createdAt).toLocaleDateString("pt-BR")}
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setPromoteTarget(row);
                      }}
                    >
                      Promover
                    </Button>
                  </td>
                </tr>
              ))}
              {(candidatesQuery.data ?? []).length === 0 && !candidatesQuery.isLoading && (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                    Nenhum candidato.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog
        open={promoteTarget !== null}
        onOpenChange={(o) => {
          if (!o) {
            setPromoteTarget(null);
            setAudience("__null__");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Promover &quot;{promoteTarget?.value ?? ""}&quot; para sistema
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <p className="text-sm text-muted-foreground">
              Escolha a audiência: genérico (todos os tenants) ou um vertical específico. A linha
              passa a ser visível conforme a regra de combined-mode (industry do tenant).
            </p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="audience">Audiência</Label>
              <Select value={audience} onValueChange={setAudience}>
                <SelectTrigger id="audience">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AUDIENCE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setPromoteTarget(null);
                setAudience("__null__");
              }}
              disabled={promote.isPending}
            >
              Cancelar
            </Button>
            <Button type="button" onClick={confirmPromote} disabled={promote.isPending}>
              {promote.isPending ? "Promovendo…" : "Promover"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
}
