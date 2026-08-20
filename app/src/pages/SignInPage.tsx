import type { ReactElement } from "react";
import { SignInWidget } from "@/auth";
import { AuthShell } from "./authShell";

export function SignInPage(): ReactElement {
  return (
    <AuthShell title="Entrar" description="Use seu e-mail cadastrado. Um login, um negócio.">
      <SignInWidget />
    </AuthShell>
  );
}
