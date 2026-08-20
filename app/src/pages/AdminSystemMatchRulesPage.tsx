// Admin UI for system import_match_rules CRUD (tenant_id IS NULL).
// System rules apply to all tenants. Constraint: target must be a system LOV
// row (CATEGORY / PAYMENT_METHOD / SUBTYPE) — tenant_values are per-tenant
// and not addressable system-wide. Optional `category` field scopes audience
// by tenants.industry.

import { useMemo, useState, type ReactElement } from "react";
import { trpc } from "@/shared/lib/trpc";
import { toast } from "sonner";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { useLov } from "@/hooks/use-lov";
import { RulesFiltersBar } from "@/components/admin/match-rules/RulesFiltersBar";
import { RulesTable, type RuleRow } from "@/components/admin/match-rules/RulesTable";
import { RuleFormDialog } from "@/components/admin/match-rules/RuleFormDialog";
import {
  AUDIENCE_NULL,
  EMPTY_SYSTEM_FORM,
  type FormState,
  type MatchKind,
  type StatusFilter,
  type SystemTargetKind,
  type TargetKind,
} from "@/components/admin/match-rules/match-rule-shared";

export function AdminSystemMatchRulesPage(): ReactElement {
  const utils = trpc.useUtils();
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");
  const [kindFilter, setKindFilter] = useState<SystemTargetKind | "ALL">("ALL");
  const [form, setForm] = useState<FormState>(EMPTY_SYSTEM_FORM);
  const [dialogOpen, setDialogOpen] = useState<boolean>(false);

  const rulesQuery = trpc.importMatchRules.listSystem.useQuery({
    status: statusFilter,
    ...(kindFilter !== "ALL" ? { targetKind: kindFilter } : {}),
  });

  const categoryLov = useLov("CATEGORY");
  const paymentMethodLov = useLov("PAYMENT_METHOD");
  const subtypeLov = useLov("TRANSACTION_SUBTYPE");

  const create = trpc.importMatchRules.createSystem.useMutation({
    onSuccess: () => {
      void utils.importMatchRules.invalidate();
      toast.success("Regra de sistema criada.");
      setDialogOpen(false);
      setForm(EMPTY_SYSTEM_FORM);
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const update = trpc.importMatchRules.updateSystem.useMutation({
    onSuccess: () => {
      void utils.importMatchRules.invalidate();
      toast.success("Regra atualizada.");
      setDialogOpen(false);
      setForm(EMPTY_SYSTEM_FORM);
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const deactivate = trpc.importMatchRules.deactivateSystem.useMutation({
    onSuccess: () => {
      void utils.importMatchRules.invalidate();
      toast.success("Regra desativada.");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const restore = trpc.importMatchRules.restoreSystem.useMutation({
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
        return categoryLov.items
          .filter((i) => i.tenantId === null)
          .map((i) => ({ id: i.id, label: i.value }));
      case "PAYMENT_METHOD":
        return paymentMethodLov.items
          .filter((i) => i.tenantId === null)
          .map((i) => ({ id: i.id, label: i.value }));
      case "SUBTYPE":
        return subtypeLov.items
          .filter((i) => i.tenantId === null)
          .map((i) => ({ id: i.id, label: i.value }));
      // System rules can't target tenant_values; the dropdown won't surface
      // these picks because RulesFiltersBar uses SYSTEM_TARGET_KINDS only.
      case "SUPPLIER":
      case "CUSTOMER":
        return [];
    }
  }, [form.targetKind, categoryLov.items, paymentMethodLov.items, subtypeLov.items]);

  function resolveTargetLabel(rule: RuleRow): string {
    if (rule.lovTargetId === null) return "—";
    return (
      categoryLov.byId.get(rule.lovTargetId)?.value ??
      paymentMethodLov.byId.get(rule.lovTargetId)?.value ??
      subtypeLov.byId.get(rule.lovTargetId)?.value ??
      "—"
    );
  }

  function handleSubmit(): void {
    const confidence = Number(form.confidence);
    const priority = Number(form.priority);
    if (Number.isNaN(confidence) || Number.isNaN(priority)) {
      toast.error("Confiança e prioridade devem ser números.");
      return;
    }
    const category = form.category === AUDIENCE_NULL ? null : form.category;

    if (form.id !== null) {
      update.mutate({
        id: form.id,
        matchKind: form.matchKind,
        pattern: form.pattern.trim(),
        confidence,
        priority,
        category,
        description: form.description.trim().length === 0 ? null : form.description.trim(),
      });
      return;
    }

    if (form.lovTargetId.length === 0) {
      toast.error("Selecione o destino da regra.");
      return;
    }

    create.mutate({
      targetKind: form.targetKind,
      matchKind: form.matchKind,
      pattern: form.pattern.trim(),
      lovTargetId: form.lovTargetId,
      confidence,
      priority,
      category,
      description: form.description.trim().length === 0 ? null : form.description.trim(),
    });
  }

  if (rulesQuery.error) {
    return (
      <AppLayout>
        <div className="mx-auto max-w-[1200px] px-6 py-10">
          <h1 className="text-2xl font-semibold">Regras de Sistema</h1>
          <p className="mt-4 text-sm text-muted-foreground">
            {rulesQuery.error.data?.code === "FORBIDDEN"
              ? "Esta página é restrita a administradores."
              : rulesQuery.error.message}
          </p>
        </div>
      </AppLayout>
    );
  }

  const rules = rulesQuery.data ?? [];
  const isMutating = create.isPending || update.isPending;

  return (
    <AppLayout>
      <div className="mx-auto max-w-[1300px] px-6 py-10">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Regras de Sistema</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Padrões aplicados a todos os tenants. Só apontam para LOV de sistema (categoria, forma
              de pagamento, subtipo). Audiência opcional restringe o público (vertical).
            </p>
          </div>
          <Button
            onClick={() => {
              setForm(EMPTY_SYSTEM_FORM);
              setDialogOpen(true);
            }}
          >
            Nova regra
          </Button>
        </div>

        <RulesFiltersBar<SystemTargetKind>
          status={statusFilter}
          onStatusChange={setStatusFilter}
          kind={kindFilter}
          onKindChange={setKindFilter}
          scope="system"
          count={rules.length}
          isLoading={rulesQuery.isLoading}
        />

        <RulesTable
          rows={rules}
          isLoading={rulesQuery.isLoading}
          showAudience={true}
          resolveTargetLabel={resolveTargetLabel}
          onEdit={(rule) => {
            setForm({
              id: rule.id,
              targetKind: rule.targetKind as TargetKind,
              matchKind: rule.matchKind as MatchKind,
              pattern: rule.pattern,
              lovTargetId: rule.lovTargetId ?? "",
              tvTargetId: "",
              category: rule.category ?? AUDIENCE_NULL,
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
      </div>

      <RuleFormDialog
        open={dialogOpen}
        onOpenChange={(o) => {
          setDialogOpen(o);
          if (!o) setForm(EMPTY_SYSTEM_FORM);
        }}
        scope="system"
        form={form}
        setForm={setForm}
        targetItems={targetItems}
        onSubmit={handleSubmit}
        isSubmitting={isMutating}
      />
    </AppLayout>
  );
}
