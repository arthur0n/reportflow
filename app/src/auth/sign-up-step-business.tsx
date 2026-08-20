// app/src/auth/sign-up-step-business.tsx
//
// Step 3 of self-service signup: user names their business; we call
// onboarding.createTenant which creates the Clerk org mirror, the tenant row
// and the admin membership in one transaction. On success we navigate to
// /dashboard — the next request resolves the new active_tenant_id via
// api/trpc/context.ts (no JWT refresh needed; tenant comes from our DB).
//
// Industry is hardcoded to "restaurant" for MVP; the backend schema accepts
// any string with that default, so the field is plumbed end-to-end ready
// for the picker to land later.

import { useState, type FormEvent, type ReactElement } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useOnboarding } from "./use-onboarding";

type Props = {
  account: {
    firstName: string;
    lastName: string;
    email: string;
  };
};

const DEFAULT_INDUSTRY = "restaurant";

function readError(err: unknown): string {
  if (err instanceof Error && err.message.length > 0) return err.message;
  return "Não foi possível criar sua conta.";
}

export function SignUpStepBusiness({ account }: Props): ReactElement {
  const [, navigate] = useLocation();
  const { submitBusiness, createTenantPending } = useOnboarding();
  const [businessName, setBusinessName] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);
    try {
      await submitBusiness({
        ...account,
        businessName: businessName.trim(),
        industry: DEFAULT_INDUSTRY,
      });
      navigate("/dashboard");
    } catch (err) {
      setError(readError(err));
    }
  }

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        void handleSubmit(e);
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="businessName">Nome do negócio</Label>
        <Input
          id="businessName"
          required
          minLength={2}
          maxLength={120}
          value={businessName}
          onChange={(e) => {
            setBusinessName(e.target.value);
          }}
        />
        <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
          Cada conta é um negócio; dentro dela cabem quantas unidades você quiser.
        </p>
      </div>
      {error !== null ? (
        <p className="text-[length:var(--fs-body-sm)] text-[color:var(--negative)]">{error}</p>
      ) : null}
      <Button type="submit" disabled={createTenantPending || businessName.trim().length < 2}>
        {createTenantPending ? "Criando..." : "Concluir"}
      </Button>
    </form>
  );
}
