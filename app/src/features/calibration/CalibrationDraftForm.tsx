// app/src/features/calibration/CalibrationDraftForm.tsx
//
// Everything §3.1 freezes TOGETHER, on one screen, because they are frozen
// together: the ordered field list, `input_mode`, and `detect_hint` — plus the
// other half of the golden fixture, the sample's confirmed values.
//
// The sample JSON is a `<textarea>` on purpose, the same call §3.2 makes for
// the outbound template authoring UI: "no Monaco, no diff viewer, no visual
// builder". A human reads what the model claims it found, fixes what is wrong,
// and presses Congelar. That IS the confirmation.

import type { ReactElement } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Section } from "@/components/ui/section";
import { FieldListEditor, type DraftField } from "./FieldListEditor";
import type { InputMode } from "@shared/validation/field-spec";

export type CalibrationDraft = {
  documentTypeName: string;
  inputMode: InputMode;
  detectHint: string[];
  fields: DraftField[];
  /** Empty string = no fixture JSON; freeze simply stores the PDF half. */
  sampleValuesJson: string;
};

export function CalibrationDraftForm({
  draft,
  onChange,
  onFreeze,
  freezing,
}: {
  draft: CalibrationDraft;
  onChange: (next: CalibrationDraft) => void;
  onFreeze: () => void;
  freezing: boolean;
}): ReactElement {
  return (
    <div className="flex flex-col gap-6">
      <Section
        eyebrow="§3.1"
        title="Proposta da IA — revise antes de congelar"
        description="Nada aqui foi gravado. O que você congelar passa a validar todas as extrações futuras deste tipo."
      >
        <div className="flex flex-wrap items-end gap-6">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cal-type-name">Nome do tipo de documento</Label>
            <Input
              id="cal-type-name"
              value={draft.documentTypeName}
              className="w-[280px]"
              onChange={(e) => {
                onChange({ ...draft, documentTypeName: e.target.value });
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            {/* A COST decision, not a capability one (§3.1): o PDF nativo
                custa ~5–20× a camada de texto extraída. */}
            <Label>Modo de leitura</Label>
            <RadioGroup
              value={draft.inputMode}
              onValueChange={(value) => {
                onChange({ ...draft, inputMode: value as InputMode });
              }}
              className="flex items-center gap-4"
            >
              <div className="flex items-center gap-2">
                <RadioGroupItem value="text" id="cal-mode-text" />
                <Label htmlFor="cal-mode-text">texto (barato)</Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value="vision" id="cal-mode-vision" />
                <Label htmlFor="cal-mode-vision">visão (digitalizações)</Label>
              </div>
            </RadioGroup>
          </div>
        </div>
      </Section>

      <Section
        eyebrow="§3.3"
        title="Pistas de detecção"
        description="Trechos literais da página 1 presentes em TODOS os documentos deste tipo. É o que faz a detecção acontecer sem custo."
      >
        <div className="flex flex-col gap-2 max-w-2xl">
          {draft.detectHint.map((hint, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                value={hint}
                aria-label={`Pista ${String(index + 1)}`}
                onChange={(e) => {
                  onChange({
                    ...draft,
                    detectHint: draft.detectHint.map((h, i) => (i === index ? e.target.value : h)),
                  });
                }}
              />
              <Button
                variant="ghost"
                size="sm"
                aria-label="Remover pista"
                onClick={() => {
                  onChange({
                    ...draft,
                    detectHint: draft.detectHint.filter((_, i) => i !== index),
                  });
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onChange({ ...draft, detectHint: [...draft.detectHint, ""] });
              }}
            >
              <Plus className="h-3.5 w-3.5" /> Pista
            </Button>
          </div>
        </div>
      </Section>

      <Section
        eyebrow="§3.1"
        title="Lista de campos"
        description="Ordenada. A descrição é como o modelo reencontra o rótulo quando o layout muda — não é um comentário."
      >
        <FieldListEditor
          fields={draft.fields}
          onChange={(fields) => {
            onChange({ ...draft, fields });
          }}
        />
      </Section>

      <Section
        eyebrow="Fixture"
        title="Valores deste exemplar"
        description="A metade JSON do fixture dourado. É validado contra a lista congelada; se não corresponder, o template é congelado mesmo assim e o JSON é descartado."
      >
        <Textarea
          value={draft.sampleValuesJson}
          rows={10}
          className="font-mono text-[length:var(--fs-body-sm)]"
          aria-label="JSON confirmado do exemplar"
          onChange={(e) => {
            onChange({ ...draft, sampleValuesJson: e.target.value });
          }}
        />
      </Section>

      <div className="flex items-center gap-3">
        <Button onClick={onFreeze} disabled={freezing}>
          {freezing ? "Congelando…" : "Congelar"}
        </Button>
        <span className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
          Recalibrar um tipo já congelado incrementa a geração e invalida as extrações existentes
          (§12.8).
        </span>
      </div>
    </div>
  );
}
