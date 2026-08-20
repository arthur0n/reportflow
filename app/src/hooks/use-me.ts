import { trpc, type TrpcOutput } from "@/shared/lib/trpc";

export type Me = TrpcOutput["users"]["me"];

type UseMeResult = {
  data: Me | undefined;
  isLoading: boolean;
  error: { message: string } | null;
};

/**
 * Read the current user's identity from the local DB (tRPC), including the
 * active tenant. Backed by `users.me`. Cached briefly so the header can render
 * the tenant pill + user chip without re-fetching on every navigation.
 */
export function useMe(): UseMeResult {
  const q = trpc.users.me.useQuery(undefined, { staleTime: 60_000 });
  return { data: q.data, isLoading: q.isLoading, error: q.error };
}
