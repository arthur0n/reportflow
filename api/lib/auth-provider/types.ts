// api/lib/auth-provider/types.ts
//
// Provider-agnostic auth interface. Anything Clerk-specific lives behind this
// seam — to swap to Cognito, write a sibling implementation and re-export it
// from `./index.ts`. The rest of the API depends only on this interface.
//
// One responsibility: verifyToken, called per-request by api/trpc/context.ts.
// There is no provisioning side. Users and orgs are created by hand in the
// Clerk dashboard, and the matching local `users` row by SQL or
// scripts/make-admin.ts (project_conventions §7). Nothing in the API mints
// identities.

export type VerifiedToken = {
  /** Provider user id — Clerk `sub` (`user_2abc…`). Becomes users.open_id. */
  sub: string;
  /** Provider org id — Clerk `org_id` (`org_2abc…`). Becomes tenant_id. */
  orgId?: string;
};

export interface AuthProvider {
  verifyToken(token: string): Promise<VerifiedToken>;
}
