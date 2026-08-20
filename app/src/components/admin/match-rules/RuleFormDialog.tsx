import type { ReactElement } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  AUDIENCE_OPTIONS,
  isLovTargetKind,
  MATCH_KINDS,
  SYSTEM_TARGET_KINDS,
  TENANT_TARGET_KINDS,
  type FormState,
  type MatchKind,
  type TargetKind,
} from "./match-rule-shared";

type TargetItem = { id: string; label: string };

type Props = {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  scope: "tenant" | "system";
  form: FormState;
  setForm: (f: FormState) => void;
  targetItems: TargetItem[];
  onSubmit: () => void;
  isSubmitting: boolean;
};

export function RuleFormDialog({
  open,
  onOpenChange,
  scope,
  form,
  setForm,
  targetItems,
  onSubmit,
  isSubmitting,
}: Props): ReactElement {
  const isEdit = form.id !== null;
  const targetKinds = scope === "tenant" ? TENANT_TARGET_KINDS : SYSTEM_TARGET_KINDS;
  const isSystemScope = scope === "system";
  const targetValue = isLovTargetKind(form.targetKind) ? form.lovTargetId : form.tvTargetId;

  function setTargetKind(v: TargetKind): void {
    setForm({ ...form, targetKind: v, lovTargetId: "", tvTargetId: "" });
  }

  function setTargetId(v: string): void {
    if (isLovTargetKind(form.targetKind)) {
      setForm({ ...form, lovTargetId: v });
    } else {
      setForm({ ...form, tvTargetId: v });
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[600px]">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Editar regra" : isSystemScope ? "Nova regra de sistema" : "Nova regra"}
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="form-targetKind">Destino</Label>
            <Select
              value={form.targetKind}
              onValueChange={(v) => {
                setTargetKind(v as TargetKind);
              }}
              disabled={isEdit}
            >
              <SelectTrigger id="form-targetKind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {targetKinds.map((k) => (
                  <SelectItem key={k.value} value={k.value}>
                    {k.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="form-target">{isSystemScope ? "Alvo (LOV de sistema)" : "Alvo"}</Label>
            <Select value={targetValue} onValueChange={setTargetId} disabled={isEdit}>
              <SelectTrigger id="form-target">
                <SelectValue placeholder="Selecione…" />
              </SelectTrigger>
              <SelectContent>
                {targetItems.map((it) => (
                  <SelectItem key={it.id} value={it.id}>
                    {it.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="form-matchKind">Tipo de match</Label>
            <Select
              value={form.matchKind}
              onValueChange={(v) => {
                setForm({ ...form, matchKind: v as MatchKind });
              }}
            >
              <SelectTrigger id="form-matchKind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MATCH_KINDS.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="form-pattern">Padrão</Label>
            <Input
              id="form-pattern"
              value={form.pattern}
              onChange={(e) => {
                setForm({ ...form, pattern: e.target.value });
              }}
              placeholder={form.matchKind === "regex" ? "\\bIFOOD\\b" : "IFOOD"}
            />
          </div>

          {isSystemScope && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="form-audience">Audiência</Label>
              <Select
                value={form.category}
                onValueChange={(v) => {
                  setForm({ ...form, category: v });
                }}
              >
                <SelectTrigger id="form-audience">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {AUDIENCE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="form-confidence">Confiança (0–100)</Label>
            <Input
              id="form-confidence"
              type="number"
              min={0}
              max={100}
              value={form.confidence}
              onChange={(e) => {
                setForm({ ...form, confidence: e.target.value });
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="form-priority">Prioridade</Label>
            <Input
              id="form-priority"
              type="number"
              min={0}
              max={10000}
              value={form.priority}
              onChange={(e) => {
                setForm({ ...form, priority: e.target.value });
              }}
            />
          </div>

          <div className="col-span-2 flex flex-col gap-1.5">
            <Label htmlFor="form-description">Descrição (opcional)</Label>
            <Textarea
              id="form-description"
              value={form.description}
              onChange={(e) => {
                setForm({ ...form, description: e.target.value });
              }}
              rows={2}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onOpenChange(false);
            }}
            disabled={isSubmitting}
          >
            Cancelar
          </Button>
          <Button type="button" onClick={onSubmit} disabled={isSubmitting}>
            {isSubmitting ? "Salvando…" : isEdit ? "Salvar" : "Criar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
