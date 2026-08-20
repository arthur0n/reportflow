import { trpc } from "@/shared/lib/trpc";

type CreateTransactionMutation = ReturnType<typeof trpc.transactions.create.useMutation>;

/**
 * Mutation hook wrapping transactions.create. Centralizes the cache-bust set —
 * a created transaction can spawn new tenant_values (creditor / cash-box) or
 * LOV rows (category / subtype / payment-method) via the form's quick-create
 * affordances, so we invalidate broadly. Pickers cache aggressively
 * (staleTime: Infinity), and stale picker data outliving a quick-create is the
 * common failure mode.
 */
export function useCreateTransaction(): CreateTransactionMutation {
  const utils = trpc.useUtils();
  return trpc.transactions.create.useMutation({
    onSuccess: () => {
      void utils.transactions.invalidate();
      void utils.listOfValues.invalidate();
      void utils.tenantValues.invalidate();
    },
  });
}
