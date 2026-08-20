// Step 1 of the streamlined import flow: bank statement only. Upload is
// fire-and-forget — parsing runs async, so an accepted file navigates
// straight to the acquirer step. Skippable for acquirer-only months.

import type { ReactElement } from "react";
import { Link, useLocation } from "wouter";
import { ArrowRight } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { UploadWidget } from "@/components/imports/UploadWidget";

export function ImportBankPage(): ReactElement {
  const [, navigate] = useLocation();

  return (
    <AppLayout>
      <PageHeader
        eyebrow="Importar · Passo 1 de 2"
        title="Extrato do banco"
        lede="Envie o extrato em OFX. O processamento continua sozinho — você segue direto para o próximo passo."
      />

      <UploadWidget
        accept=".ofx"
        title="Arraste o extrato do banco (.ofx)"
        onUploaded={() => {
          navigate("/imports/acquirer");
        }}
      />

      <div className="flex items-center gap-5 pt-1 text-[length:var(--fs-body-sm)]">
        <Link
          href="/imports/acquirer"
          className="inline-flex items-center gap-1.5 font-[550] text-[color:var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] rounded-sm"
        >
          Pular — quero enviar só as vendas da adquirente <ArrowRight className="h-3.5 w-3.5" />
        </Link>
        <Link
          href="/imports"
          className="text-[color:var(--ink-mute)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] rounded-sm"
        >
          Ver histórico
        </Link>
      </div>
    </AppLayout>
  );
}
