// api/lib/auth-provider/types.ts
//
// Provider-agnostic auth interface. Anything Clerk-specific lives behind this
// seam — to swap to Cognito, write a sibling implementation and re-export it
// from `./index.ts`. The rest of the API depends only on this interface.
//
// Two responsibilities:
//   1. verifyToken — read-side; called per-request by api/trpc/context.ts.
//   2. provisioning — write-side; called by api/services/onboarding.ts when we
//      mint a tenant. The split mirrors what Cognito gives us natively
//      (verifier vs. AdminCreate*/CreateGroup commands).
//
// Self-service signup never goes through createUser here — the user is
// created on the frontend via the provider's own SDK so password handling,
// email verification and future MFA stay in the provider's hands. createUser
// is the staff-created path only.

export type VerifiedToken = {
  sub: string;
  orgId?: string;
};

export type CreateUserInput = {
  email: string;
  name?: string | null;
};

export type CreateOrganizationInput = {
  name: string;
  ownerExternalId: string;
};

export type CreatePasswordSetupTicketInput = {
  externalUserId: string;
};

export type CreatedPasswordSetupTicket = {
  url: string;
  expiresAt: Date;
};

export interface AuthProvider {
  verifyToken(token: string): Promise<VerifiedToken>;

  /** Staff-created flow only. Self-service uses the provider's frontend SDK. */
  createUser(input: CreateUserInput): Promise<{ externalId: string }>;

  /** Mirror our tenant on the provider side; owner becomes the org's admin. */
  createOrganization(input: CreateOrganizationInput): Promise<{ externalId: string }>;

  /** One-time link the staff-created user clicks to set their password. */
  createPasswordSetupTicket(
    input: CreatePasswordSetupTicketInput,
  ): Promise<CreatedPasswordSetupTicket>;
}
