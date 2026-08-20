// app/src/auth/sign-up-step-verify.tsx
//
// Step 2 of self-service signup: user enters the 6-digit code emailed by
// Clerk. On success the Clerk session goes active (setActive) so subsequent
// tRPC requests carry a valid JWT for verifiedProcedure on createTenant.

import { useState, type FormEvent, type ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useOnboarding } from "./use-onboarding";

type Props = {
  email: string;
  onSuccess: () => void;
};

function readClerkError(err: unknown): string {
  if (typeof err === "object" && err !== null && "errors" in err) {
    const errors = (err as { errors?: Array<{ message?: string }> }).errors;
    const first = errors?.[0]?.message;
    if (typeof first === "string" && first.length > 0) return first;
  }
  if (err instanceof Error && err.message.length > 0) return err.message;
  return "Não foi possível confirmar o código.";
}

export function SignUpStepVerify({ email, onSuccess }: Props): ReactElement {
  const { isReady, submitVerification, resendVerification } = useOnboarding();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [resentAt, setResentAt] = useState<number | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await submitVerification({ code });
      onSuccess();
    } catch (err) {
      setError(readClerkError(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResend(): Promise<void> {
    setError(null);
    setResending(true);
    try {
      await resendVerification();
      setResentAt(Date.now());
    } catch (err) {
      setError(readClerkError(err));
    } finally {
      setResending(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        void handleSubmit(e);
      }}
    >
      <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)]">
        Enviamos um código de 6 dígitos para{" "}
        <span className="font-[500] text-[color:var(--ink)]">{email}</span>.
      </p>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="code">Código de verificação</Label>
        <Input
          id="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          required
          value={code}
          onChange={(e) => {
            setCode(e.target.value.replace(/\D/g, ""));
          }}
        />
      </div>
      {error !== null ? (
        <p className="text-[length:var(--fs-body-sm)] text-[color:var(--negative)]">{error}</p>
      ) : null}
      {resentAt !== null && error === null ? (
        <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)]">
          Código reenviado.
        </p>
      ) : null}
      <Button type="submit" disabled={!isReady || submitting || code.length !== 6}>
        {submitting ? "Confirmando..." : "Confirmar e-mail"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={!isReady || resending}
        onClick={() => {
          void handleResend();
        }}
      >
        {resending ? "Reenviando..." : "Reenviar código"}
      </Button>
    </form>
  );
}
