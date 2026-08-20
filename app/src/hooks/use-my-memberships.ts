import { trpc, type TrpcOutput } from "@/shared/lib/trpc";

export type MyMembership = TrpcOutput["users"]["listMyMemberships"][number];

type UseMyMembershipsResult = {
  data: MyMembership[] | undefined;
  isLoading: boolean;
  error: { message: string } | null;
};

/**
 * List the current user's memberships across tenants. Drives the tenant
 * switcher in the header — hidden when the user belongs to a single tenant.
 */
export function useMyMemberships(): UseMyMembershipsResult {
  const q = trpc.users.listMyMemberships.useQuery();
  return { data: q.data, isLoading: q.isLoading, error: q.error };
}
