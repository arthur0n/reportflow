import type { ReactElement, ReactNode } from "react";
import { ClerkProvider } from "@clerk/clerk-react";
import { ptBR } from "@clerk/localizations";

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
if (PUBLISHABLE_KEY.length === 0) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY");
}

export function AuthProvider({ children }: { children: ReactNode }): ReactElement {
  return (
    <ClerkProvider
      publishableKey={PUBLISHABLE_KEY}
      signInUrl="/sign-in"
      signUpUrl="/sign-up"
      afterSignInUrl="/dashboard"
      afterSignUpUrl="/dashboard"
      afterSignOutUrl="/sign-in"
      localization={ptBR}
    >
      {children}
    </ClerkProvider>
  );
}
