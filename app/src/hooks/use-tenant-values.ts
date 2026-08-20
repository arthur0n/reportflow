import { useMemo } from "react";
import { trpc, type TrpcOutput } from "@/shared/lib/trpc";
import type { TenantValueKind } from "@shared/constants/tenant-value-kinds";

type TenantValueItem = TrpcOutput["tenantValues"]["list"][number];

export type UseTenantValuesResult = {
  items: TenantValueItem[];
  byId: Map<string, TenantValueItem>;
  label: (id: string | null | undefined, fallback?: string) => string;
  isLoading: boolean;
};

/**
 * Fetch active tenant_values rows for a given `kind`. Cached for the session;
 * tenant_values change rarely and are read on every classification render.
 */
export function useTenantValues({ kind }: { kind: TenantValueKind }): UseTenantValuesResult {
  const q = trpc.tenantValues.list.useQuery({ kind, status: "active" }, { staleTime: Infinity });

  const items = q.data ?? [];
  const byId = useMemo(() => new Map(items.map((r) => [r.id, r])), [items]);

  return {
    items,
    byId,
    label: (id, fallback = "") => {
      if (id === null || id === undefined || id.length === 0) return fallback;
      const found = byId.get(id)?.name;
      if (typeof found === "string") return found;
      return fallback.length > 0 ? fallback : id;
    },
    isLoading: q.isLoading,
  };
}
