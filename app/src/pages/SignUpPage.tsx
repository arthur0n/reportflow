import type { ReactElement } from "react";
import { SignUpFlow } from "@/auth";
import { AuthShell } from "./authShell";

export function SignUpPage(): ReactElement {
  return (
    <AuthShell
      title="Criar conta"
      description="Três passos: sua conta, confirmação de e-mail e o nome do negócio."
    >
      <SignUpFlow />
    </AuthShell>
  );
}
