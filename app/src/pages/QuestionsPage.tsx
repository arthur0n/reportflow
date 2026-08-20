import { useState, type ReactElement } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Input } from "@/components/ui/input";
import { Rule } from "@/components/ui/rule";
import { trpc } from "@/shared/lib/trpc";
import { useLov } from "@/hooks/use-lov";
import { cn } from "@/lib/utils";
import { ItemDetail } from "./QuestionsItemDetail";

type QuestionKind = "question" | "bug" | "feedback";
type QuestionStatus = "open" | "answered" | "closed" | "wont_fix";
type QuestionRole = "po" | "se" | "dev" | "ai";

type LovItem = { code: string; value: string };

type FilterState = {
  status: "" | QuestionStatus;
  kind: "" | QuestionKind;
  owner: "" | QuestionRole;
  feature: string;
};

type DraftState = {
  kind: QuestionKind;
  owner: QuestionRole;
  author: QuestionRole;
  feature: string;
  title: string;
  body: string;
};

const EMPTY_DRAFT: DraftState = {
  kind: "question",
  owner: "po",
  author: "dev",
  feature: "",
  title: "",
  body: "",
};

const STATUS_VARIANT: Record<string, "default" | "success" | "secondary" | "outline"> = {
  open: "default",
  answered: "success",
  closed: "secondary",
  wont_fix: "outline",
};

const KIND_VARIANT: Record<string, "outline" | "destructive" | "accent"> = {
  question: "outline",
  bug: "destructive",
  feedback: "accent",
};

function formatRelative(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `${min}m atrás`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h atrás`;
  const d = Math.floor(hr / 24);
  if (d < 30) return `${d}d atrás`;
  return new Date(iso).toLocaleDateString("pt-BR");
}

const SELECT_CLASSES = cn(
  "h-9 px-2 bg-transparent",
  "text-[length:var(--fs-body-sm)] text-[color:var(--ink)]",
  "border-0 border-b border-[color:var(--rule-strong)]",
  "focus:outline-none focus:border-[color:var(--accent)]",
);

function SelectField({
  label,
  value,
  onChange,
  items,
  includeAll = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  items: LovItem[];
  includeAll?: boolean;
}): ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <Eyebrow>{label}</Eyebrow>
      <select
        className={SELECT_CLASSES}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      >
        {includeAll && <option value="">Todos</option>}
        {items.map((it) => (
          <option key={it.code} value={it.code}>
            {it.value}
          </option>
        ))}
      </select>
    </label>
  );
}

export function QuestionsPage(): ReactElement {
  const utils = trpc.useUtils();
  const kinds = useLov("qf_kind");
  const statuses = useLov("qf_status");
  const owners = useLov("qf_owner");

  const [filters, setFilters] = useState<FilterState>({
    status: "",
    kind: "",
    owner: "",
    feature: "",
  });
  const [draftOpen, setDraftOpen] = useState(false);
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const featuresQuery = trpc.questions.features.useQuery();
  const featureOptions = featuresQuery.data ?? [];

  const listInput = {
    ...(filters.status !== "" && { status: filters.status }),
    ...(filters.kind !== "" && { kind: filters.kind }),
    ...(filters.owner !== "" && { owner: filters.owner }),
    ...(filters.feature !== "" && { feature: filters.feature }),
  };
  const listQuery = trpc.questions.list.useQuery(listInput);
  const items = listQuery.data ?? [];

  const invalidateAll = async (): Promise<void> => {
    await Promise.all([utils.questions.list.invalidate(), utils.questions.features.invalidate()]);
  };

  const create = trpc.questions.create.useMutation({
    onSuccess: async () => {
      await invalidateAll();
      setDraft(EMPTY_DRAFT);
      setDraftOpen(false);
    },
  });
  const update = trpc.questions.update.useMutation({
    onSuccess: async () => {
      await invalidateAll();
    },
  });
  const answer = trpc.questions.answer.useMutation({
    onSuccess: async () => {
      await utils.questions.list.invalidate();
    },
  });
  const remove = trpc.questions.delete.useMutation({
    onSuccess: async () => {
      await invalidateAll();
      setExpandedId(null);
    },
  });

  return (
    <AppLayout>
      <PageHeader
        eyebrow="Desenvolvimento"
        title="Perguntas e Feedback"
        lede="Rastreio temporário enquanto montamos o MVP — perguntas da IA, bugs e feedback do time."
        aside={
          <Button
            variant={draftOpen ? "outline" : "default"}
            size="sm"
            onClick={() => {
              setDraftOpen((v) => !v);
            }}
          >
            {draftOpen ? "Cancelar" : "Novo"}
          </Button>
        }
      />

      {draftOpen && (
        <DraftPanel
          draft={draft}
          setDraft={setDraft}
          kindItems={kinds.items}
          ownerItems={owners.items}
          featureOptions={featureOptions}
          submitting={create.isPending}
          errorMessage={create.error?.message ?? null}
          onSubmit={() => {
            if (draft.title.trim().length === 0 || draft.body.trim().length === 0) return;
            const trimmedFeature = draft.feature.trim();
            create.mutate({
              kind: draft.kind,
              owner: draft.owner,
              author: draft.author,
              title: draft.title.trim(),
              body: draft.body.trim(),
              ...(trimmedFeature.length > 0 && { feature: trimmedFeature }),
            });
          }}
        />
      )}

      <div className="flex flex-wrap items-end gap-4 pb-2">
        <SelectField
          label="Status"
          value={filters.status}
          items={statuses.items}
          includeAll
          onChange={(v) => {
            setFilters((f) => ({ ...f, status: v as FilterState["status"] }));
          }}
        />
        <SelectField
          label="Tipo"
          value={filters.kind}
          items={kinds.items}
          includeAll
          onChange={(v) => {
            setFilters((f) => ({ ...f, kind: v as FilterState["kind"] }));
          }}
        />
        <SelectField
          label="Responsável"
          value={filters.owner}
          items={owners.items}
          includeAll
          onChange={(v) => {
            setFilters((f) => ({ ...f, owner: v as FilterState["owner"] }));
          }}
        />
        <label className="flex flex-col gap-1 min-w-[140px]">
          <Eyebrow>Feature</Eyebrow>
          <select
            className={SELECT_CLASSES}
            value={filters.feature}
            onChange={(e) => {
              setFilters((f) => ({ ...f, feature: e.target.value }));
            }}
          >
            <option value="">Todas</option>
            {featureOptions.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
      </div>

      <Rule strong />

      {listQuery.isLoading && (
        <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">Carregando…</p>
      )}
      {listQuery.error !== null && (
        <p className="text-[length:var(--fs-body-sm)] text-[color:var(--negative)]">
          Erro: {listQuery.error.message}
        </p>
      )}
      {!listQuery.isLoading && items.length === 0 && (
        <div className="py-12 flex flex-col items-center gap-2 text-center">
          <Eyebrow>Vazio</Eyebrow>
          <p className="font-serif text-[length:var(--fs-display)] font-[400] italic leading-[1.1] text-[color:var(--ink-soft)]">
            Nenhum registro.
          </p>
          <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
            Use “Novo” acima ou rode <code>pnpm ask</code> no terminal.
          </p>
        </div>
      )}

      <ul className="flex flex-col gap-px bg-[color:var(--rule)] border border-[color:var(--rule)]">
        {items.map((item) => (
          <li key={item.id} className="bg-[color:var(--paper)] flex flex-col">
            <button
              type="button"
              className="flex flex-wrap items-center gap-3 p-4 text-left hover:bg-[color:var(--paper-sink)]"
              onClick={() => {
                setExpandedId(expandedId === item.id ? null : item.id);
              }}
            >
              <span className="text-[length:var(--fs-eyebrow)] uppercase tracking-[0.1em] font-[550] text-[color:var(--ink-mute)] tabular-nums w-12 shrink-0">
                #{item.ref}
              </span>
              <Badge variant={KIND_VARIANT[item.kind] ?? "outline"}>
                {kinds.label(item.kind, item.kind)}
              </Badge>
              {item.feature !== null && <Badge variant="outline">{item.feature}</Badge>}
              <span className="font-serif text-[length:var(--fs-section)] font-[500] leading-[1.2] text-[color:var(--ink)] flex-1 min-w-0">
                {item.title}
              </span>
              <Badge variant="secondary">{owners.label(item.owner, item.owner)}</Badge>
              <Badge variant={STATUS_VARIANT[item.status] ?? "default"}>
                {statuses.label(item.status, item.status)}
              </Badge>
              <span className="text-[length:var(--fs-eyebrow)] uppercase tracking-[0.1em] text-[color:var(--ink-mute)] tabular-nums">
                {owners.label(item.author, item.author)} · {formatRelative(item.createdAt)}
              </span>
            </button>
            {expandedId === item.id && (
              <ItemDetail
                item={item}
                ownerLabel={owners.label}
                statusItems={statuses.items}
                ownerItems={owners.items}
                onAnswer={(payload) => {
                  answer.mutate(payload);
                }}
                onUpdate={(payload) => {
                  update.mutate(payload);
                }}
                onDelete={() => {
                  remove.mutate(item.id);
                }}
                pending={answer.isPending || update.isPending || remove.isPending}
              />
            )}
          </li>
        ))}
      </ul>
    </AppLayout>
  );
}

function DraftPanel({
  draft,
  setDraft,
  kindItems,
  ownerItems,
  featureOptions,
  submitting,
  errorMessage,
  onSubmit,
}: {
  draft: DraftState;
  setDraft: React.Dispatch<React.SetStateAction<DraftState>>;
  kindItems: LovItem[];
  ownerItems: LovItem[];
  featureOptions: string[];
  submitting: boolean;
  errorMessage: string | null;
  onSubmit: () => void;
}): ReactElement {
  const disabled = submitting || draft.title.trim().length === 0 || draft.body.trim().length === 0;
  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[color:var(--rule)] p-4 bg-[color:var(--paper-sink)]">
      <Eyebrow>Novo registro</Eyebrow>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <SelectField
          label="Tipo"
          value={draft.kind}
          items={kindItems}
          onChange={(v) => {
            setDraft((d) => ({ ...d, kind: v as QuestionKind }));
          }}
        />
        <SelectField
          label="Responsável"
          value={draft.owner}
          items={ownerItems}
          onChange={(v) => {
            setDraft((d) => ({ ...d, owner: v as QuestionRole }));
          }}
        />
        <SelectField
          label="Autor"
          value={draft.author}
          items={ownerItems}
          onChange={(v) => {
            setDraft((d) => ({ ...d, author: v as QuestionRole }));
          }}
        />
      </div>
      <label className="flex flex-col gap-1">
        <Eyebrow>Feature</Eyebrow>
        <Input
          list="qf-feature-options"
          value={draft.feature}
          onChange={(e) => {
            setDraft((d) => ({ ...d, feature: e.target.value }));
          }}
          placeholder="Ex: fluxo, categoria, painel — opcional"
        />
        <datalist id="qf-feature-options">
          {featureOptions.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      </label>
      <label className="flex flex-col gap-1">
        <Eyebrow>Título</Eyebrow>
        <Input
          value={draft.title}
          onChange={(e) => {
            setDraft((d) => ({ ...d, title: e.target.value }));
          }}
          placeholder="Resumo curto"
        />
      </label>
      <label className="flex flex-col gap-1">
        <Eyebrow>Descrição</Eyebrow>
        <textarea
          className="min-h-[120px] bg-transparent px-1 py-2 text-[length:var(--fs-body)] text-[color:var(--ink)] border-0 border-b border-[color:var(--rule-strong)] focus:outline-none focus:border-[color:var(--accent)] resize-y"
          value={draft.body}
          onChange={(e) => {
            setDraft((d) => ({ ...d, body: e.target.value }));
          }}
          placeholder="Contexto, passos para reproduzir, links, etc."
        />
      </label>
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={onSubmit} disabled={disabled}>
          {submitting ? "Salvando…" : "Criar"}
        </Button>
        {errorMessage !== null && (
          <span className="text-[length:var(--fs-body-sm)] text-[color:var(--negative)]">
            {errorMessage}
          </span>
        )}
      </div>
    </div>
  );
}
