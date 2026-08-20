import { trpc } from "@/shared/lib/trpc";
import { useQueryClient } from "@tanstack/react-query";

type SwitchTenantInput = { tenantId: string };

type UseSwitchTenantResult = {
  mutate: (input: SwitchTenantInput) => void;
  isPending: boolean;
};

/**
 * Switch the active tenant for the current user. Every cached query is
 * tenant-scoped, so on success we invalidate both the tRPC utils and the
 * raw React Query cache to force a clean refetch under the new tenant.
 */
export function useSwitchTenant(): UseSwitchTenantResult {
  const utils = trpc.useUtils();
  const qc = useQueryClient();
  const m = trpc.users.switchTenant.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.invalidate(), qc.invalidateQueries()]);
    },
  });
  return {
    mutate: (input) => {
      m.mutate(input);
    },
    isPending: m.isPending,
  };
}
