import type { ReactElement, ReactNode } from "react";
import { Redirect } from "wouter";
import { SignedIn, SignedOut } from "@clerk/clerk-react";

export function Protected({ children }: { children: ReactNode }): ReactElement {
  return (
    <>
      <SignedIn>{children}</SignedIn>
      <SignedOut>
        <Redirect to="/sign-in" />
      </SignedOut>
    </>
  );
}
