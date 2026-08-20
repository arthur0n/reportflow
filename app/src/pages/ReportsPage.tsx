// app/src/pages/ReportsPage.tsx
//
// Report drafts, publication, and print (decisions §5). Minimal on purpose —
// the screen exists to exercise the lifecycle end to end, not to be the
// finished reports UX.
//
//   create   → pins a template VERSION and a client (§5.3)
//   attach   → binds documents BY ROLE (§3.2)
//   slots    → the prose, editable; a human edit survives regeneration (§5.2)
//   render   → live for a draft, ARCHIVED for a published report (§5.1)
//   publicar → the freeze protocol, including the numeral guard (§12.12c)
//   imprimir → window.print() on the same HTML (§5.4), no PDF dependency
//
// A published report shows where its HTML is archived and prints from THAT.
// Re-rendering a published report from the template would be the exact thing
// freezing exists to prevent: a shell edit retroactively changing a document
// someone's customer already received.

import { useState, type ReactElement } from "react";
import { toast } from "sonner";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { Section } from "@/components/ui/section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc } from "@/shared/lib/trpc";
import { PreviewFrame } from "@/features/outbound/PreviewFrame";
import { printHtml } from "@/features/outbound/print";
import { ReportRoles } from "@/features/reports/ReportRoles";
import { ReportSlots } from "@/features/reports/ReportSlots";

const NO_CLIENT = "__none__";

function NewReportForm({ onCreated }: { onCreated: (id: string) => void }): ReactElement {
  const utils = trpc.useUtils();
  const templates = trpc.outbound.list.useQuery();
  const clients = trpc.reports.clients.useQuery();
  const [versionId, setVersionId] = useState("");
  const [clientId, setClientId] = useState(NO_CLIENT);
  const [title, setTitle] = useState("");

  const create = trpc.reports.create.useMutation({
    onSuccess: (row) => {
      setTitle("");
      void utils.reports.list.invalidate();
      onCreated(row.id);
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  // Only templates that actually have a version can be pinned — §5.3 pins a
  // VERSION, so a template with none is not something a report can point at.
  const options = (templates.data ?? []).filter((t) => t.latestVersionId !== null);

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex min-w-[16rem] flex-col gap-1">
        <Label htmlFor="rep-tpl">Modelo (versão fixada)</Label>
        <Select value={versionId} onValueChange={setVersionId}>
          <SelectTrigger id="rep-tpl">
            <SelectValue placeholder="Selecione" />
          </SelectTrigger>
          <SelectContent>
            {options.map((tpl) => (
              <SelectItem key={tpl.id} value={tpl.latestVersionId ?? ""}>
                {tpl.name} — v{String(tpl.latestVersion)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex min-w-[14rem] flex-col gap-1">
        <Label htmlFor="rep-client">Cliente</Label>
        <Select value={clientId} onValueChange={setClientId}>
          <SelectTrigger id="rep-client">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_CLIENT}>Sem cliente</SelectItem>
            {(clients.data ?? []).map((client) => (
              <SelectItem key={client.id} value={client.id}>
                {client.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex min-w-[14rem] flex-col gap-1">
        <Label htmlFor="rep-title">Título</Label>
        <Input
          id="rep-title"
          value={title}
          placeholder="Relatório de agosto"
          onChange={(e) => {
            setTitle(e.target.value);
          }}
        />
      </div>

      <Button
        type="button"
        disabled={versionId.length === 0 || create.isPending}
        onClick={() => {
          create.mutate({
            templateVersionId: versionId,
            clientId: clientId === NO_CLIENT ? null : clientId,
            title: title.trim().length > 0 ? title.trim() : null,
          });
        }}
      >
        Criar relatório
      </Button>
    </div>
  );
}

function ReportDetailView({ reportId }: { reportId: string }): ReactElement {
  const utils = trpc.useUtils();
  const detail = trpc.reports.get.useQuery({ reportId });
  const rendered = trpc.reports.render.useQuery({ reportId });

  const refresh = (): void => {
    void utils.reports.get.invalidate();
    void utils.reports.render.invalidate();
  };

  const publish = trpc.reports.publish.useMutation({
    onSuccess: (out) => {
      void utils.reports.list.invalidate();
      refresh();
      toast.success(
        out.published ? "Relatório publicado e arquivado." : "Este relatório já estava publicado.",
      );
    },
    onError: (err) => {
      // The numeral guard's refusal arrives here, naming slot and token.
      toast.error(err.message, { duration: 12_000 });
    },
  });

  if (detail.data === undefined) {
    return <p className="text-[length:var(--fs-body-sm)]">Carregando…</p>;
  }
  const report = detail.data;
  const frozen = report.frozenAt !== null;
  const view = rendered.data;
  const html = view !== undefined && view.status !== "aguardando" ? view.html : null;

  return (
    <Section
      eyebrow={frozen ? "§5.1 publicado" : `rascunho · v${String(report.version)}`}
      title={report.title ?? "Relatório"}
      description={
        report.clientName === null ? "Sem cliente associado." : `Cliente: ${report.clientName}`
      }
      aside={
        <div className="flex items-center gap-2">
          {!frozen && (
            <Button
              type="button"
              disabled={publish.isPending}
              onClick={() => {
                publish.mutate({ reportId });
              }}
            >
              Publicar
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={html === null}
            onClick={() => {
              if (html !== null && !printHtml(html)) {
                toast.error("Permita pop-ups para imprimir.");
              }
            }}
          >
            Imprimir
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-6">
        {frozen && (
          <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)]">
            HTML congelado em <code>{report.frozenHtmlS3Key}</code> em{" "}
            {new Date(report.frozenAt).toLocaleString("pt-BR")}. A impressão usa esse arquivo, não
            uma nova renderização — editar o modelo depois não muda o que já foi enviado.
          </p>
        )}

        <div className="flex flex-col gap-2">
          <Label>Documentos por papel</Label>
          <ReportRoles
            reportId={reportId}
            roles={report.roles}
            frozen={frozen}
            onChanged={refresh}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label>Prosa</Label>
          <ReportSlots reportId={reportId} slots={report.slots} frozen={frozen} onSaved={refresh} />
        </div>

        <div className="flex flex-col gap-2">
          <Label>Pré-visualização</Label>
          {view === undefined && (
            <p className="text-[length:var(--fs-body-sm)] italic text-[color:var(--ink-mute)]">
              Renderizando…
            </p>
          )}
          {view?.status === "aguardando" && (
            <p className="text-[length:var(--fs-body-sm)]">
              Aguardando documento para: <b>{view.missingRoles.join(", ")}</b>.
            </p>
          )}
          {view?.status === "rascunho" && view.numeralViolations.length > 0 && (
            <p className="text-[length:var(--fs-body-sm)] text-[color:var(--negative)]">
              Guarda numérica (§12.12): a prosa contém números sem fonte determinística —{" "}
              {view.numeralViolations.map((v) => `${v.slot}: “${v.token}”`).join("; ")}. A
              publicação será bloqueada até corrigir.
            </p>
          )}
          {view?.status === "publicado" && view.html === null && (
            <p className="text-[length:var(--fs-body-sm)]">
              O arquivo congelado não está mais disponível no armazenamento.
            </p>
          )}
          {html !== null && <PreviewFrame html={html} title="Pré-visualização do relatório" />}
        </div>
      </div>
    </Section>
  );
}

export function ReportsPage(): ReactElement {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const list = trpc.reports.list.useQuery();
  const reports = list.data ?? [];

  return (
    <AppLayout>
      <PageHeader
        eyebrow="§5"
        title="Relatórios"
        lede="O rascunho renderiza ao vivo a partir do JSON e da versão fixada. Publicar congela o HTML — o que foi enviado é o que fica arquivado."
      />

      <Section eyebrow="Novo" title="Criar relatório">
        <NewReportForm onCreated={setSelectedId} />
      </Section>

      <Section eyebrow="Lista" title="Relatórios da conta">
        {reports.length === 0 ? (
          <p className="py-4 text-[length:var(--fs-body-sm)] italic text-[color:var(--ink-mute)]">
            Nenhum relatório ainda.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-[color:var(--rule)]">
            {reports.map((report) => (
              <li key={report.id} className="flex items-center justify-between gap-4 py-2">
                <button
                  type="button"
                  className="text-left text-[length:var(--fs-body)] hover:text-[color:var(--accent)]"
                  onClick={() => {
                    setSelectedId(report.id);
                  }}
                >
                  {report.title ?? "Sem título"}
                  {report.clientName !== null && (
                    <span className="text-[color:var(--ink-mute)]"> · {report.clientName}</span>
                  )}
                </button>
                <Badge variant={report.frozenAt === null ? "outline" : "secondary"}>
                  {report.frozenAt === null ? "rascunho" : "publicado"}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {selectedId !== null && <ReportDetailView reportId={selectedId} />}
    </AppLayout>
  );
}
