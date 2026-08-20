// app/src/auth/sign-up-step-account.tsx
//
// Step 1 of self-service signup: collect name + email + password and hand
// them to Clerk via signUp.create + prepareEmailAddressVerification. The
// page parent stores firstName/lastName/email in state so step 3 can pass
// them through to onboarding.createTenant (the orchestrator upserts the
// users row from these if the user.created webhook hasn't landed yet).

import { useState, type FormEvent, type ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useOnboarding } from "./use-onboarding";

type Props = {
  onSuccess: (data: { firstName: string; lastName: string; email: string }) => void;
};

function readClerkError(err: unknown): string {
  if (typeof err === "object" && err !== null && "errors" in err) {
    const errors = (err as { errors?: Array<{ message?: string }> }).errors;
    const first = errors?.[0]?.message;
    if (typeof first === "string" && first.length > 0) return first;
  }
  if (err instanceof Error && err.message.length > 0) return err.message;
  return "Não foi possível criar a conta.";
}

export function SignUpStepAccount({ onSuccess }: Props): ReactElement {
  const { isReady, submitAccount } = useOnboarding();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await submitAccount({ firstName, lastName, email, password });
      onSuccess({ firstName, lastName, email });
    } catch (err) {
      setError(readClerkError(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        void handleSubmit(e);
      }}
    >
      <div className="grid grid-cols-2 gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="firstName">Nome</Label>
          <Input
            id="firstName"
            autoComplete="given-name"
            required
            value={firstName}
            onChange={(e) => {
              setFirstName(e.target.value);
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="lastName">Sobrenome</Label>
          <Input
            id="lastName"
            autoComplete="family-name"
            required
            value={lastName}
            onChange={(e) => {
              setLastName(e.target.value);
            }}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email">E-mail</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
          }}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="password">Senha</Label>
        <Input
          id="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={8}
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
          }}
        />
        <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
          Mínimo 8 caracteres.
        </p>
      </div>
      {error !== null ? (
        <p className="text-[length:var(--fs-body-sm)] text-[color:var(--negative)]">{error}</p>
      ) : null}
      <Button type="submit" disabled={!isReady || submitting}>
        {submitting ? "Enviando..." : "Continuar"}
      </Button>
    </form>
  );
}
