import { useState, type ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { Eyebrow } from "@/components/ui/eyebrow";
import { Rule } from "@/components/ui/rule";

type QuestionStatus = "open" | "answered" | "closed" | "wont_fix";
type QuestionRole = "po" | "se" | "dev" | "ai";

type LovItem = { code: string; value: string };

export type ItemRow = {
  id: string;
  ref: number;
  kind: string;
  feature: string | null;
  title: string;
  body: string;
  owner: string;
  author: string;
  status: string;
  answer: string | null;
  answeredBy: string | null;
  answeredAt: string | null;
  createdAt: string;
};

const SELECT_CLASSES = [
  "h-9 px-2 bg-transparent",
  "text-[length:var(--fs-body-sm)] text-[color:var(--ink)]",
  "border-0 border-b border-[color:var(--rule-strong)]",
  "focus:outline-none focus:border-[color:var(--accent)]",
].join(" ");

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

export function ItemDetail({
  item,
  ownerLabel,
  statusItems,
  ownerItems,
  onAnswer,
  onUpdate,
  onDelete,
  pending,
}: {
  item: ItemRow;
  ownerLabel: (code: string | null | undefined, fallback?: string) => string;
  statusItems: LovItem[];
  ownerItems: LovItem[];
  onAnswer: (payload: {
    id: string;
    answer: string;
    answeredBy: QuestionRole;
    status: QuestionStatus;
  }) => void;
  onUpdate: (payload: { id: string; status?: QuestionStatus; owner?: QuestionRole }) => void;
  onDelete: () => void;
  pending: boolean;
}): ReactElement {
  const [answerText, setAnswerText] = useState(item.answer ?? "");
  const [answeredBy, setAnsweredBy] = useState<string>(item.answeredBy ?? "po");
  const [nextStatus, setNextStatus] = useState<string>("answered");

  const hasAnswer = item.answer !== null && item.answer.length > 0;

  return (
    <div className="px-4 pb-4 pt-1 flex flex-col gap-4 bg-[color:var(--paper-sink)] border-t border-[color:var(--rule)]">
      <div>
        <Eyebrow>Descrição</Eyebrow>
        <p className="text-[length:var(--fs-body)] text-[color:var(--ink)] whitespace-pre-wrap mt-1">
          {item.body}
        </p>
      </div>

      {hasAnswer && (
        <div>
          <Eyebrow tone="positive">
            Resposta · {ownerLabel(item.answeredBy, "—")}
            {item.answeredAt !== null && ` · ${formatRelative(item.answeredAt)}`}
          </Eyebrow>
          <p className="text-[length:var(--fs-body)] text-[color:var(--ink)] whitespace-pre-wrap mt-1">
            {item.answer}
          </p>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <Eyebrow>{hasAnswer ? "Atualizar resposta" : "Responder"}</Eyebrow>
        <textarea
          className="min-h-[100px] bg-[color:var(--paper)] px-2 py-2 text-[length:var(--fs-body)] text-[color:var(--ink)] border border-[color:var(--rule)] rounded-[var(--radius-sm)] focus:outline-none focus:border-[color:var(--accent)] resize-y"
          value={answerText}
          onChange={(e) => {
            setAnswerText(e.target.value);
          }}
          placeholder="Resposta, decisão, link para PR…"
        />
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <Eyebrow>Por</Eyebrow>
            <select
              className={SELECT_CLASSES}
              value={answeredBy}
              onChange={(e) => {
                setAnsweredBy(e.target.value);
              }}
            >
              {ownerItems.map((it) => (
                <option key={it.code} value={it.code}>
                  {it.value}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <Eyebrow>Novo status</Eyebrow>
            <select
              className={SELECT_CLASSES}
              value={nextStatus}
              onChange={(e) => {
                setNextStatus(e.target.value);
              }}
            >
              {statusItems.map((it) => (
                <option key={it.code} value={it.code}>
                  {it.value}
                </option>
              ))}
            </select>
          </label>
          <Button
            size="sm"
            onClick={() => {
              if (answerText.trim().length === 0) return;
              onAnswer({
                id: item.id,
                answer: answerText.trim(),
                answeredBy: answeredBy as QuestionRole,
                status: nextStatus as QuestionStatus,
              });
            }}
            disabled={pending || answerText.trim().length === 0}
          >
            Salvar resposta
          </Button>
        </div>
      </div>

      <Rule />

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[length:var(--fs-eyebrow)] uppercase tracking-[0.1em] text-[color:var(--ink-mute)]">
          Status rápido:
        </span>
        {statusItems.map((s) => (
          <Button
            key={s.code}
            size="sm"
            variant={s.code === item.status ? "default" : "outline"}
            disabled={pending || s.code === item.status}
            onClick={() => {
              onUpdate({ id: item.id, status: s.code as QuestionStatus });
            }}
          >
            {s.value}
          </Button>
        ))}
        <Button size="sm" variant="ghost" disabled={pending} onClick={onDelete} className="ml-auto">
          Excluir
        </Button>
      </div>
    </div>
  );
}
