// app/src/pages/TemplatesPage.tsx
//
// The outbound-template authoring screen (decisions §3.2). Deliberately the
// austere thing the design doc names: "a plain <textarea> plus an <iframe>
// preview rendered against the calibration fixture. No Monaco, no diff viewer,
// no visual builder."
//
// THE PREVIEW IS RENDERED ON THE SERVER and arrives as finished HTML, which
// goes into a `sandbox=""` iframe (§12.4). Two consequences worth stating
// because they are the reason it is not done in the browser: Handlebars never
// reaches the bundle, and the preview is the SAME engine that will render the
// report, so it cannot disagree with the document.
//
// Saving writes version N+1 and never touches N (§5.3). The version list on
// the right is therefore append-only, and an existing report keeps pointing at
// whatever version it pinned.

import { useEffect, useState, type ReactElement } from "react";
import { toast } from "sonner";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { Section } from "@/components/ui/section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { trpc } from "@/shared/lib/trpc";
import { useDocumentTypes } from "@/hooks/use-document-types";
import { TemplateInputsEditor, type RoleRow } from "@/features/outbound/TemplateInputsEditor";
import { PreviewFrame } from "@/features/outbound/PreviewFrame";

const STARTER_HTML = `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <title>{{meta.titulo}}</title>
    <style>
      /* §5.4 — contrato de impressão. O Chrome não implementa margin boxes de
         CSS Paged Media, então não há numeração de páginas (decidido). */
      @page { size: A4; margin: 18mm 15mm; }
      .capa  { break-after: page; }
      .secao { break-inside: avoid; }
      thead  { display: table-header-group; }
      tr     { break-inside: avoid; }
      body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; font-size: 11px; color: #1f2733; }
      h1 { font-size: 18px; text-transform: uppercase; }
      table { width: 100%; border-collapse: collapse; }
      td, th { padding: 6px 8px; border-bottom: 1px solid #e6eaf1; text-align: left; }
      .num { text-align: right; font-variant-numeric: tabular-nums; }
      .nota { border-left: 3px solid #3f6fb0; background: #f7f9fc; padding: 10px 14px; }
      @media print {
        .no-print { display: none !important; }
        html, body { background: #fff !important; }
      }
    </style>
  </head>
  <body>
    <h1 class="secao">{{meta.titulo}}</h1>
    <p>Emissão: {{date meta.emissao}} · {{meta.n_documentos}} documento(s)</p>

    <section class="secao">
      <div class="nota">{{ai "notas"}}</div>
    </section>
  </body>
</html>
`;

type Draft = {
  html: string;
  roles: RoleRow[];
  guidelines: Record<string, string>;
};

const EMPTY_DRAFT: Draft = { html: STARTER_HTML, roles: [], guidelines: {} };

function NewTemplateForm({ onCreated }: { onCreated: (id: string) => void }): ReactElement {
  const utils = trpc.useUtils();
  const [name, setName] = useState("");
  const create = trpc.outbound.create.useMutation({
    onSuccess: (row) => {
      setName("");
      void utils.outbound.list.invalidate();
      onCreated(row.id);
      toast.success("Modelo criado. Escreva o HTML e salve a primeira versão.");
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex min-w-[16rem] flex-col gap-1">
        <Label htmlFor="tpl-name">Nome do modelo</Label>
        <Input
          id="tpl-name"
          value={name}
          placeholder="Análise mensal"
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
      </div>
      <Button
        type="button"
        disabled={name.trim().length === 0 || create.isPending}
        onClick={() => {
          create.mutate({ name: name.trim(), description: null });
        }}
      >
        Novo modelo
      </Button>
    </div>
  );
}

export function TemplatesPage(): ReactElement {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);

  const utils = trpc.useUtils();
  const list = trpc.outbound.list.useQuery();
  const { options } = useDocumentTypes();
  const detail = trpc.outbound.get.useQuery(
    { templateId: selectedId ?? "" },
    { enabled: selectedId !== null },
  );

  // Loading a template replaces the draft with its LATEST version. Editing
  // then saves N+1 — nothing here can write over the version being read.
  useEffect(() => {
    const latest = detail.data?.latest;
    if (latest == null) {
      setDraft(EMPTY_DRAFT);
      setPreviewHtml(null);
      return;
    }
    setDraft({
      html: latest.html,
      roles: latest.inputs.map((role) => ({
        key: role.key,
        documentTypeId: role.documentTypeId,
        cardinality: role.cardinality,
        required: role.required,
      })),
      guidelines: Object.fromEntries(latest.slots.map((s) => [s.slug, s.guideline])),
    });
    setPreviewHtml(null);
  }, [detail.data]);

  const payload = {
    html: draft.html,
    inputs: draft.roles.map((role) => ({
      key: role.key.trim(),
      documentTypeId: role.documentTypeId,
      cardinality: role.cardinality,
      required: role.required,
    })),
    slots: Object.entries(draft.guidelines)
      .filter(([, guideline]) => guideline.trim().length > 0)
      .map(([slug, guideline]) => ({ slug, guideline, maxWords: 180 })),
  };

  const preview = trpc.outbound.preview.useMutation({
    onSuccess: (out) => {
      setPreviewHtml(out.html);
      if (out.rolesWithoutFixture.length > 0) {
        toast.info(`Sem amostra calibrada para: ${out.rolesWithoutFixture.join(", ")}.`);
      }
    },
    onError: (err) => {
      setPreviewHtml(null);
      toast.error(err.message);
    },
  });

  const save = trpc.outbound.saveVersion.useMutation({
    onSuccess: (out) => {
      void utils.outbound.list.invalidate();
      void utils.outbound.get.invalidate();
      toast.success(`Versão v${String(out.version)} salva.`);
      if (out.dryRun.status === "skipped") {
        toast.info(out.dryRun.reason);
      }
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const templates = list.data ?? [];
  const busy = preview.isPending || save.isPending;

  return (
    <AppLayout>
      <PageHeader
        eyebrow="§3.2"
        title="Modelos de saída"
        lede="HTML com slots, impresso em A4. O número vem da extração; a prosa vem da análise; o layout não vem de nenhum dos dois."
      />

      <Section
        eyebrow="Modelos"
        title="Da conta e do sistema"
        aside={<NewTemplateForm onCreated={setSelectedId} />}
      >
        {templates.length === 0 ? (
          <p className="py-4 text-[length:var(--fs-body-sm)] italic text-[color:var(--ink-mute)]">
            Nenhum modelo ainda.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-[color:var(--rule)]">
            {templates.map((tpl) => (
              <li key={tpl.id} className="flex items-center justify-between gap-4 py-2">
                <button
                  type="button"
                  className="text-left text-[length:var(--fs-body)] hover:text-[color:var(--accent)]"
                  onClick={() => {
                    setSelectedId(tpl.id);
                  }}
                >
                  {tpl.name}
                </button>
                <div className="flex items-center gap-2">
                  {tpl.system && <Badge variant="outline">Sistema</Badge>}
                  <Badge variant={tpl.latestVersion === null ? "outline" : "secondary"}>
                    {tpl.latestVersion === null ? "sem versão" : `v${String(tpl.latestVersion)}`}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {selectedId !== null && detail.data !== undefined && (
        <Section
          eyebrow={detail.data.system ? "somente leitura" : "§5.3 versões imutáveis"}
          title={detail.data.name}
          description={
            detail.data.system
              ? "Modelo do sistema: visível para todas as contas e editável apenas pelo administrador da plataforma."
              : "Salvar escreve a versão N+1. Relatórios existentes continuam apontando para a versão que fixaram."
          }
          aside={
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  preview.mutate(payload);
                }}
              >
                Pré-visualizar
              </Button>
              <Button
                type="button"
                disabled={busy || detail.data.system}
                onClick={() => {
                  save.mutate({ templateId: selectedId, ...payload });
                }}
              >
                Salvar versão
              </Button>
            </div>
          }
        >
          <div className="flex flex-col gap-6">
            <div className="flex flex-col gap-2">
              <Label>Entradas nomeadas</Label>
              <TemplateInputsEditor
                rows={draft.roles}
                options={options}
                disabled={detail.data.system}
                onChange={(roles) => {
                  setDraft((d) => ({ ...d, roles }));
                }}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="tpl-html">Modelo (Handlebars)</Label>
              <Textarea
                id="tpl-html"
                value={draft.html}
                spellCheck={false}
                readOnly={detail.data.system}
                className="min-h-[24rem] font-mono text-[12px] leading-[1.5]"
                onChange={(e) => {
                  setDraft((d) => ({ ...d, html: e.target.value }));
                }}
              />
              <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
                Quatro construções: <code>{"{{papel.campo}}"}</code>,{" "}
                <code>{"{{#each papel}}"}</code>, <code>{"{{#if papel}}"}</code> e{" "}
                <code>{'{{ai "slug"}}'}</code>. Mais <code>{"{{money x_cents}}"}</code> e{" "}
                <code>{"{{date x}}"}</code>. Sem partials e sem <code>{"{{{"}</code> — o escape de
                HTML é obrigatório.
              </p>
              <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
                O documento impresso é inerte: nada de <code>&lt;script&gt;</code>,{" "}
                <code>&lt;iframe&gt;</code>, <code>&lt;form&gt;</code>, <code>&lt;svg&gt;</code>,{" "}
                <code>&lt;meta http-equiv&gt;</code> nem atributos <code>on…</code>. Em URLs valem{" "}
                <code>https:</code>, <code>mailto:</code>, <code>tel:</code>, caminhos relativos e{" "}
                <code>data:image/*</code> (exceto SVG) — e o esquema tem de ser literal, nunca uma
                expressão. <code>&lt;style&gt;</code> continua permitido: o contrato de impressão é
                CSS.
              </p>
            </div>

            {detail.data.latest !== null && detail.data.latest.slots.length > 0 && (
              <div className="flex flex-col gap-3">
                <Label>Diretrizes por slot</Label>
                {detail.data.latest.slots.map((slot) => (
                  <div key={slot.slug} className="flex flex-col gap-1">
                    <span className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)]">
                      {slot.slug}
                    </span>
                    <Textarea
                      value={draft.guidelines[slot.slug] ?? ""}
                      readOnly={detail.data.system}
                      className="min-h-[5rem]"
                      onChange={(e) => {
                        const value = e.target.value;
                        setDraft((d) => ({
                          ...d,
                          guidelines: { ...d.guidelines, [slot.slug]: value },
                        }));
                      }}
                    />
                  </div>
                ))}
                <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
                  A diretriz é o que a análise recebe para escrever este slot. Slots novos aparecem
                  aqui depois de salvar a versão.
                </p>
              </div>
            )}

            {previewHtml !== null && (
              <div className="flex flex-col gap-2">
                <Label>Pré-visualização (amostra calibrada)</Label>
                <PreviewFrame html={previewHtml} title="Pré-visualização do modelo" />
              </div>
            )}

            <div className="flex flex-col gap-1">
              <Label>Versões</Label>
              <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
                {detail.data.versions.length === 0
                  ? "Nenhuma versão salva."
                  : detail.data.versions.map((v) => `v${String(v.version)}`).join(" · ")}
              </p>
            </div>
          </div>
        </Section>
      )}
    </AppLayout>
  );
}
