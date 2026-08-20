// Tenant import_match_rules CRUD. Lives under /parameters/import-rules and
// is gated by protectedProcedure — any active tenant member can manage their
// own rules. Target picker switches between LOV (CATEGORY / PAYMENT_METHOD /
// SUBTYPE) and tenant_values (SUPPLIER / CUSTOMER) based on the chosen
// targetKind.

import { useMemo, useState, type ReactElement } from "react";
import { trpc } from "@/shared/lib/trpc";
import { toast } from "sonner";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { useLov } from "@/hooks/use-lov";
import { useTenantValues } from "@/hooks/use-tenant-values";
import { RulesFiltersBar } from "@/components/admin/match-rules/RulesFiltersBar";
import { RulesTable, type RuleRow } from "@/components/admin/match-rules/RulesTable";
import { RuleFormDialog } from "@/components/admin/match-rules/RuleFormDialog";
import {
  EMPTY_TENANT_FORM,
  isLovTargetKind,
  type FormState,
  type MatchKind,
  type StatusFilter,
  type TargetKind,
} from "@/components/admin/match-rules/match-rule-shared";

export function ImportRulesPage(): ReactElement {
  const utils = trpc.useUtils();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [kindFilter, setKindFilter] = useState<TargetKind | "ALL">("ALL");
  const [form, setForm] = useState<FormState>(EMPTY_TENANT_FORM);
  const [dialogOpen, setDialogOpen] = useState<boolean>(false);

  const rulesQuery = trpc.importMatchRules.list.useQuery({
    status: statusFilter,
    ...(kindFilter !== "ALL" ? { targetKind: kindFilter } : {}),
  });

  const categoryLov = useLov("CATEGORY");
  const paymentMethodLov = useLov("PAYMENT_METHOD");
  const subtypeLov = useLov("TRANSACTION_SUBTYPE");
  const supplierTv = useTenantValues({ kind: "SUPPLIER" });
  const customerTv = useTenantValues({ kind: "CUSTOMER" });

  const create = trpc.importMatchRules.create.useMutation({
    onSuccess: () => {
      void utils.importMatchRules.invalidate();
      toast.success("Regra criada.");
      setDialogOpen(false);
      setForm(EMPTY_TENANT_FORM);
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const update = trpc.importMatchRules.update.useMutation({
    onSuccess: () => {
      void utils.importMatchRules.invalidate();
      toast.success("Regra atualizada.");
      setDialogOpen(false);
      setForm(EMPTY_TENANT_FORM);
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const deactivate = trpc.importMatchRules.deactivate.useMutation({
    onSuccess: () => {
      void utils.importMatchRules.invalidate();
      toast.success("Regra desativada.");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const restore = trpc.importMatchRules.restore.useMutation({
    onSuccess: () => {
      void utils.importMatchRules.invalidate();
      toast.success("Regra restaurada.");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const targetItems = useMemo(() => {
    switch (form.targetKind) {
      case "CATEGORY":
        return categoryLov.items.map((i) => ({ id: i.id, label: i.value }));
      case "PAYMENT_METHOD":
        return paymentMethodLov.items.map((i) => ({ id: i.id, label: i.value }));
      case "SUBTYPE":
        return subtypeLov.items.map((i) => ({ id: i.id, label: i.value }));
      case "SUPPLIER":
        return supplierTv.items.map((i) => ({ id: i.id, label: i.name }));
      case "CUSTOMER":
        return customerTv.items.map((i) => ({ id: i.id, label: i.name }));
    }
  }, [
    form.targetKind,
    categoryLov.items,
    paymentMethodLov.items,
    subtypeLov.items,
    supplierTv.items,
    customerTv.items,
  ]);

  function resolveTargetLabel(rule: RuleRow): string {
    if (rule.lovTargetId !== null) {
      return (
        categoryLov.byId.get(rule.lovTargetId)?.value ??
        paymentMethodLov.byId.get(rule.lovTargetId)?.value ??
        subtypeLov.byId.get(rule.lovTargetId)?.value ??
        "—"
      );
    }
    if (rule.tvTargetId !== null) {
      return (
        supplierTv.byId.get(rule.tvTargetId)?.name ??
        customerTv.byId.get(rule.tvTargetId)?.name ??
        "—"
      );
    }
    return "—";
  }

  function handleSubmit(): void {
    const confidence = Number(form.confidence);
    const priority = Number(form.priority);
    if (Number.isNaN(confidence) || Number.isNaN(priority)) {
      toast.error("Confiança e prioridade devem ser números.");
      return;
    }

    if (form.id !== null) {
      update.mutate({
        id: form.id,
        matchKind: form.matchKind,
        pattern: form.pattern.trim(),
        confidence,
        priority,
        description: form.description.trim().length === 0 ? null : form.description.trim(),
      });
      return;
    }

    const isLov = isLovTargetKind(form.targetKind);
    const targetId = isLov ? form.lovTargetId : form.tvTargetId;
    if (targetId.length === 0) {
      toast.error("Selecione o destino da regra.");
      return;
    }

    create.mutate({
      targetKind: form.targetKind,
      matchKind: form.matchKind,
      pattern: form.pattern.trim(),
      confidence,
      priority,
      description: form.description.trim().length === 0 ? null : form.description.trim(),
      ...(isLov ? { lovTargetId: targetId } : { tvTargetId: targetId }),
    });
  }

  if (rulesQuery.error) {
    return (
      <AppLayout>
        <PageHeader eyebrow="Parâmetros" title="Regras de Importação" />
        <p className="text-[length:var(--fs-body-sm)] text-[color:var(--negative)]">
          Erro ao carregar regras: {rulesQuery.error.message}
        </p>
      </AppLayout>
    );
  }

  const rules = rulesQuery.data ?? [];
  const isMutating = create.isPending || update.isPending;

  return (
    <AppLayout>
      <PageHeader
        eyebrow="Parâmetros"
        title="Regras de Importação"
        lede="Padrões regex/contém que pré-preenchem categoria, forma de pagamento, fornecedor ou cliente ao importar extratos."
        aside={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setForm(EMPTY_TENANT_FORM);
              setDialogOpen(true);
            }}
          >
            Nova regra
          </Button>
        }
      />

      <RulesFiltersBar<TargetKind>
        status={statusFilter}
        onStatusChange={setStatusFilter}
        kind={kindFilter}
        onKindChange={setKindFilter}
        scope="tenant"
        count={rules.length}
        isLoading={rulesQuery.isLoading}
      />

      <RulesTable
        rows={rules}
        isLoading={rulesQuery.isLoading}
        showAudience={false}
        resolveTargetLabel={resolveTargetLabel}
        onEdit={(rule) => {
          setForm({
            id: rule.id,
            targetKind: rule.targetKind as TargetKind,
            matchKind: rule.matchKind as MatchKind,
            pattern: rule.pattern,
            lovTargetId: rule.lovTargetId ?? "",
            tvTargetId: rule.tvTargetId ?? "",
            category: form.category,
            confidence: String(rule.confidence),
            priority: String(rule.priority),
            description: rule.description ?? "",
          });
          setDialogOpen(true);
        }}
        onDeactivate={(id) => {
          deactivate.mutate(id);
        }}
        onRestore={(id) => {
          restore.mutate(id);
        }}
        isDeactivating={deactivate.isPending}
        isRestoring={restore.isPending}
      />

      <RuleFormDialog
        open={dialogOpen}
        onOpenChange={(o) => {
          setDialogOpen(o);
          if (!o) setForm(EMPTY_TENANT_FORM);
        }}
        scope="tenant"
        form={form}
        setForm={setForm}
        targetItems={targetItems}
        onSubmit={handleSubmit}
        isSubmitting={isMutating}
      />
    </AppLayout>
  );
}
