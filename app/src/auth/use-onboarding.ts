// app/src/auth/use-onboarding.ts
//
// Bundles the three step actions of self-service signup so the page + step
// components stay dumb (just inputs + submit handlers).
//
// Step 1 (account) and Step 2 (verify) drive Clerk's frontend SDK so password
// handling, email verification and future MFA stay in the provider's hands.
// Step 3 (business) calls our backend orchestrator (onboarding.createTenant),
// which creates the Clerk org mirror, the tenant row, and the admin
// membership in one transaction.
//
// On success of step 2, setActive() makes the session valid — so by the time
// step 3 fires, the tRPC client's getToken() returns a JWT and ctx.externalUserId
// is populated for verifiedProcedure.

import { useSignUp } from "@clerk/clerk-react";
import { trpc } from "@/shared/lib/trpc";

type AccountInput = {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
};

type VerifyInput = {
  code: string;
};

type BusinessInput = {
  email: string;
  firstName: string;
  lastName: string;
  businessName: string;
  industry: string;
};

export type UseOnboardingResult = {
  isReady: boolean;
  submitAccount: (input: AccountInput) => Promise<void>;
  submitVerification: (input: VerifyInput) => Promise<void>;
  resendVerification: () => Promise<void>;
  submitBusiness: (input: BusinessInput) => Promise<{ tenantId: string }>;
  createTenantPending: boolean;
};

export function useOnboarding(): UseOnboardingResult {
  const { isLoaded, signUp, setActive } = useSignUp();
  const createTenant = trpc.onboarding.createTenant.useMutation();

  return {
    isReady: isLoaded === true,

    async submitAccount({ firstName, lastName, email, password }) {
      if (!isLoaded) {
        throw new Error("Provedor de autenticação ainda carregando.");
      }
      await signUp.create({
        firstName,
        lastName,
        emailAddress: email,
        password,
      });
      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
    },

    async submitVerification({ code }) {
      if (!isLoaded) {
        throw new Error("Provedor de autenticação ainda carregando.");
      }
      const result = await signUp.attemptEmailAddressVerification({ code });
      if (result.status !== "complete") {
        throw new Error("Não foi possível confirmar o e-mail.");
      }
      if (result.createdSessionId !== null) {
        await setActive({ session: result.createdSessionId });
      }
    },

    async resendVerification() {
      if (!isLoaded) {
        throw new Error("Provedor de autenticação ainda carregando.");
      }
      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
    },

    async submitBusiness(input) {
      return createTenant.mutateAsync(input);
    },

    createTenantPending: createTenant.isPending,
  };
}
