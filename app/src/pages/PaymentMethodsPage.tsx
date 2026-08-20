import { useMemo, useState, type ReactElement } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { trpc, type TrpcOutput } from "@/shared/lib/trpc";
import { toast } from "sonner";
import { CreatePaymentMethodDialog } from "@/features/payment-methods/CreatePaymentMethodDialog";
import {
  EditPaymentMethodDialog,
  type EditablePaymentMethod,
} from "@/features/payment-methods/EditPaymentMethodDialog";
import {
  DeactivatePaymentMethodDialog,
  type DeactivablePaymentMethod,
} from "@/features/payment-methods/DeactivatePaymentMethodDialog";
import { LovParameterTable } from "@/components/parameters/LovParameterTable";
import { LovParameterTabs, type LovParameterTab } from "@/components/parameters/LovParameterTabs";

type Row = TrpcOutput["paymentMethods"]["list"][number];

export function PaymentMethodsPage(): ReactElement {
  const utils = trpc.useUtils();
  const listQuery = trpc.paymentMethods.list.useQuery({ status: "all", scope: "combined" });
  const [tab, setTab] = useState<LovParameterTab>("ativos");
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<EditablePaymentMethod | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<DeactivablePaymentMethod | null>(null);

  const restore = trpc.paymentMethods.restore.useMutation({
    onSuccess: () => {
      void utils.paymentMethods.invalidate();
      void utils.listOfValues.invalidate();
      toast.success("Forma de pagamento reativada.");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const all = useMemo(() => listQuery.data ?? [], [listQuery.data]);
  const filtered = useMemo<Row[]>(
    () =>
      tab === "ativos"
        ? all.filter((r) => r.deletedAt === null)
        : all.filter((r) => r.deletedAt !== null && !r.isSystem),
    [all, tab],
  );

  return (
    <AppLayout>
      <PageHeader
        eyebrow="Parâmetros"
        title="Formas de Pagamento"
        lede="Catálogo do sistema (somente leitura) + suas extensões. Alimenta o dropdown de lançamento de transações."
        aside={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setCreateOpen(true);
            }}
          >
            Nova forma de pagamento
          </Button>
        }
      />

      <LovParameterTabs
        rows={all}
        tab={tab}
        onTabChange={setTab}
        ariaLabel="Filtro de formas de pagamento"
      />

      {listQuery.error && (
        <p className="text-[length:var(--fs-body-sm)] text-[color:var(--negative)]">
          Erro: {listQuery.error.message}
        </p>
      )}

      <LovParameterTable<Row>
        rows={filtered}
        isLoading={listQuery.isLoading}
        emptyMessage={
          tab === "ativos"
            ? "Nenhuma forma de pagamento ativa."
            : "Nenhuma forma de pagamento inativa."
        }
        showInactive={tab === "inativos"}
        onEdit={(r) => {
          setEditTarget({ id: r.id, name: r.name });
        }}
        onDeactivate={(r) => {
          setDeactivateTarget({ id: r.id, name: r.name });
        }}
        onRestore={(r) => {
          restore.mutate(r.id);
        }}
        isRestoring={restore.isPending}
      />

      <CreatePaymentMethodDialog open={createOpen} onOpenChange={setCreateOpen} />
      <EditPaymentMethodDialog
        paymentMethod={editTarget}
        open={editTarget !== null}
        onOpenChange={(open) => {
          if (!open) setEditTarget(null);
        }}
      />
      <DeactivatePaymentMethodDialog
        paymentMethod={deactivateTarget}
        open={deactivateTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeactivateTarget(null);
        }}
      />
    </AppLayout>
  );
}
