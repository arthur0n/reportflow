import type { ReactElement } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { trpc } from "@/shared/lib/trpc";

// Placeholder dashboard. Domain widgets (ledger, DRE, metrics) were removed
// with the scaffold's finance domain (see the prune-scaffold issue) — this
// stays a minimal shell that compiles and confirms the authenticated app
// boots until the real domain lands.
export function DashboardPage(): ReactElement {
  const meQuery = trpc.users.me.useQuery();

  return (
    <AppLayout>
      <PageHeader
        eyebrow="Visão geral"
        title="Painel"
        lede="Nenhum módulo de domínio instalado ainda."
      />

      {meQuery.data?.activeTenantName != null && (
        <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
          Conectado como {meQuery.data.name ?? meQuery.data.email} · {meQuery.data.activeTenantName}
        </p>
      )}
    </AppLayout>
  );
}
