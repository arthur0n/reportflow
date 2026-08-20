import { trpc, type TrpcOutput } from "@/shared/lib/trpc";

export type Me = TrpcOutput["users"]["me"];

type UseMeResult = {
  data: Me | undefined;
  isLoading: boolean;
  error: { message: string } | null;
};

/**
 * Read the current user's identity + role from the local DB (tRPC). Backed by
 * `users.me`; the tenant is the Clerk org on the session. Cached briefly so
 * the header and AdminGate can render without re-fetching on every navigation.
 */
export function useMe(): UseMeResult {
  const q = trpc.users.me.useQuery(undefined, { staleTime: 60_000 });
  return { data: q.data, isLoading: q.isLoading, error: q.error };
}
