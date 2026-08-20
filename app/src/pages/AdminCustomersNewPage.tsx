import { useState, type FormEvent, type ReactElement } from "react";
import { trpc } from "@/shared/lib/trpc";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Result = {
  tenantId: string;
  inviteUrl: string;
  inviteExpiresAt: Date;
};

export function AdminCustomersNewPage(): ReactElement {
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [copied, setCopied] = useState(false);

  const createCustomer = trpc.onboarding.createCustomer.useMutation({
    onSuccess: (data) => {
      setResult({
        tenantId: data.tenantId,
        inviteUrl: data.inviteUrl,
        inviteExpiresAt: data.inviteExpiresAt,
      });
      setEmail("");
      setFirstName("");
      setLastName("");
      setBusinessName("");
    },
  });

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setResult(null);
    setCopied(false);
    await createCustomer.mutateAsync({
      email: email.trim(),
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      businessName: businessName.trim(),
      industry: "restaurant",
    });
  }

  async function copyInvite(): Promise<void> {
    if (result === null) return;
    await navigator.clipboard.writeText(result.inviteUrl);
    setCopied(true);
  }

  const error = createCustomer.error;
  const errorMessage =
    error?.data?.code === "FORBIDDEN"
      ? "Esta página é restrita a administradores."
      : (error?.message ?? null);

  return (
    <AppLayout>
      <div className="mx-auto max-w-[640px] px-6 py-10">
        <h1 className="text-2xl font-semibold">Novo cliente</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Cria um novo cliente e usuário admin. O link de definição de senha aparece abaixo após a
          criação — envie ao cliente fora da plataforma.
        </p>

        <form
          className="mt-8 flex flex-col gap-5"
          onSubmit={(e) => {
            void handleSubmit(e);
          }}
        >
          <div className="grid grid-cols-2 gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="firstName">Nome</Label>
              <Input
                id="firstName"
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
              required
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
              }}
            />
          </div>

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
          </div>

          {errorMessage !== null ? (
            <p className="text-[length:var(--fs-body-sm)] text-[color:var(--negative)]">
              {errorMessage}
            </p>
          ) : null}

          <Button type="submit" disabled={createCustomer.isPending}>
            {createCustomer.isPending ? "Criando..." : "Criar cliente"}
          </Button>
        </form>

        {result !== null ? (
          <div className="mt-10 flex flex-col gap-3 border-t border-[color:var(--rule)] pt-6">
            <h2 className="font-serif text-lg font-[500]">Cliente criado</h2>
            <dl className="flex flex-col gap-2 text-[length:var(--fs-body-sm)]">
              <div className="flex gap-2">
                <dt className="text-[color:var(--ink-mute)]">ID do cliente:</dt>
                <dd className="font-mono">{result.tenantId}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="text-[color:var(--ink-mute)]">Expira em:</dt>
                <dd>{result.inviteExpiresAt.toLocaleString("pt-BR")}</dd>
              </div>
            </dl>
            <Label htmlFor="inviteUrl">Link de definição de senha</Label>
            <div className="flex gap-2">
              <Input id="inviteUrl" readOnly value={result.inviteUrl} className="font-mono" />
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  void copyInvite();
                }}
              >
                {copied ? "Copiado" : "Copiar"}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </AppLayout>
  );
}
