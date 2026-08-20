import type { ReactElement } from "react";
import { SignInWidget } from "@/auth";
import { AuthShell } from "./authShell";

export function SignInPage(): ReactElement {
  return (
    <AuthShell title="Entrar" description="Use o e-mail cadastrado pela sua conta.">
      <SignInWidget />
    </AuthShell>
  );
}
