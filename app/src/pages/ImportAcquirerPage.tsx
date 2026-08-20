// Step 2 of the streamlined import flow: acquirer sales report. No gate on
// the bank side — matching re-runs whenever either side lands, so order
// doesn't matter. The provider is detected from the file itself (each
// parser recognizes its own header); no picklist to get wrong.

import type { ReactElement } from "react";
import { Link, useLocation } from "wouter";
import { ArrowRight } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { UploadWidget } from "@/components/imports/UploadWidget";
import { Badge } from "@/components/ui/badge";
import { useLov } from "@/hooks/use-lov";

export function ImportAcquirerPage(): ReactElement {
  const [, navigate] = useLocation();
  const acquirers = useLov("ACQUIRER");

  return (
    <AppLayout>
      <PageHeader
        eyebrow="Importar · Passo 2 de 2"
        title="Vendas da adquirente"
        lede="Envie o relatório detalhado de vendas em CSV. A conciliação roda sozinha assim que o arquivo é processado."
      />

      <UploadWidget
        accept=".csv"
        title="Arraste o relatório de vendas (.csv)"
        onUploaded={() => {
          navigate("/conciliation");
        }}
      />

      <div className="flex flex-wrap items-center gap-2 text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
        <span>A adquirente é detectada automaticamente pelo arquivo.</span>
        {acquirers.items.map((a) => (
          <Badge key={a.id} variant="outline">
            {a.value}
          </Badge>
        ))}
      </div>

      <div className="flex items-center gap-5 pt-1 text-[length:var(--fs-body-sm)]">
        <Link
          href="/conciliation"
          className="inline-flex items-center gap-1.5 font-[550] text-[color:var(--accent)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] rounded-sm"
        >
          Pular — ir para a conciliação <ArrowRight className="h-3.5 w-3.5" />
        </Link>
        <Link
          href="/imports/bank"
          className="text-[color:var(--ink-mute)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] rounded-sm"
        >
          Voltar ao extrato
        </Link>
      </div>
    </AppLayout>
  );
}
