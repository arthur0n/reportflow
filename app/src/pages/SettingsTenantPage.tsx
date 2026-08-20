import { useEffect, useState, type ReactElement } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { Section } from "@/components/ui/section";
import { Checkbox } from "@/components/ui/checkbox";
import { DataRow } from "@/components/ui/data-row";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { trpc } from "@/shared/lib/trpc";
import { formatDate } from "@/shared/lib/format";
import { toast } from "sonner";

/**
 * Tenant settings — read-mostly. The only editable field for F&F is the
 * tenant name; CNPJ / timezone / fiscal-year-start are surfaced read-only
 * even though `tenants.update` accepts them. Billing fields are managed by
 * the ReportFlow team (no edit affordance here).
 */
export function SettingsTenantPage(): ReactElement {
  const utils = trpc.useUtils();
  const tenantQuery = trpc.tenants.current.useQuery();

  const [name, setName] = useState("");
  const [originalName, setOriginalName] = useState("");

  useEffect(() => {
    if (tenantQuery.data) {
      setName(tenantQuery.data.name);
      setOriginalName(tenantQuery.data.name);
    }
  }, [tenantQuery.data]);

  const update = trpc.tenants.update.useMutation({
    onSuccess: () => {
      void utils.tenants.invalidate();
      // Nav + route gating read the mode from users.me — refresh it too.
      void utils.users.me.invalidate();
      toast.success("Configurações atualizadas.");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed === originalName) return;
    update.mutate({ name: trimmed });
  }

  if (tenantQuery.isLoading) {
    return (
      <AppLayout>
        <PageHeader title="Configurações" />
        <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">Carregando…</p>
      </AppLayout>
    );
  }

  if (tenantQuery.error) {
    return (
      <AppLayout>
        <PageHeader title="Configurações" />
        <p className="text-[length:var(--fs-body-sm)] text-[color:var(--negative)]">
          Erro ao carregar configurações: {tenantQuery.error.message}
        </p>
      </AppLayout>
    );
  }

  const tenant = tenantQuery.data;
  if (!tenant) {
    return (
      <AppLayout>
        <PageHeader title="Configurações" />
        <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
          Nenhuma empresa ativa.
        </p>
      </AppLayout>
    );
  }

  const dirty = name.trim() !== originalName && name.trim().length > 0;

  return (
    <AppLayout>
      <PageHeader title="Configurações" />

      <Section title="Dados da empresa">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4 max-w-xl">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tenant-name">Nome da empresa</Label>
            <Input
              id="tenant-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              maxLength={200}
              required
            />
          </div>
          <div>
            <Button type="submit" disabled={update.isPending || !dirty}>
              {update.isPending ? "Salvando…" : "Salvar"}
            </Button>
          </div>
        </form>

        <div className="flex flex-col mt-2">
          <DataRow eyebrow="Setor" primary={tenant.industry} />
          <DataRow eyebrow="CNPJ" primary={tenant.cnpj ?? "—"} />
          <DataRow eyebrow="Fuso horário" primary={tenant.timezone} />
          <DataRow eyebrow="Mês inicial do exercício" primary={String(tenant.fiscalYearStart)} />
        </div>
      </Section>

      <Section title="Modo de uso">
        <label className="flex items-start gap-3 max-w-xl cursor-pointer">
          <Checkbox
            checked={tenant.mode === "import_only"}
            disabled={update.isPending}
            onCheckedChange={(checked) => {
              update.mutate({ mode: checked === true ? "import_only" : "full" });
            }}
            className="mt-0.5"
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-[length:var(--fs-body)] text-[color:var(--ink)]">
              Modo simplificado (somente importações)
            </span>
            <span className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
              Mostra apenas a importação de extratos e faturas com a conferência de valores.
              Desmarque para liberar o aplicativo completo.
            </span>
          </span>
        </label>
      </Section>

      <Section title="Faturamento">
        <div className="flex flex-col">
          <DataRow eyebrow="Plano" primary={tenant.plan} />
          <DataRow
            eyebrow="Fim do período de teste"
            primary={tenant.trialEndsAt !== null ? formatDate(tenant.trialEndsAt) : "—"}
          />
          <DataRow eyebrow="E-mail de cobrança" primary={tenant.billingEmail ?? "—"} />
        </div>
        <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)] mt-2">
          Estes campos são gerenciados pela equipe ReportFlow.
        </p>
      </Section>
    </AppLayout>
  );
}

export default SettingsTenantPage;
