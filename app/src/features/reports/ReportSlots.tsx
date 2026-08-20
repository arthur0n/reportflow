// app/src/features/reports/ReportSlots.tsx
//
// §5.2 — the prose slots, editable and regenerable.
//
// THREE FACTS THIS COMPONENT HAS TO MAKE VISIBLE, because each one changes
// what the next click does:
//
//   editado por pessoa   — regeneration will SKIP this slot. Pressing
//                          [Regerar] on it therefore asks first: that is
//                          §5.2's "regerar mesmo assim", and it is per slot.
//                          Saving a text is what sets the flag (the mutation
//                          MEANS edited; it is not an input the client sends).
//   guarda numérica      — §12.12c. The prose contains a numeral with no
//                          deterministic source. ADVISORY here; publication
//                          recomputes the guard and refuses.
//   contestado           — §12.13. A second model would not confirm a claim.
//                          BLOCKING at publish, and the only way out is to
//                          rewrite the slot (which retires the verdict along
//                          with the prose it judged) or verify again.
//
// Austere on purpose: this screen exists to exercise the lifecycle, not to be
// the finished reports UX.

import { useState, type ReactElement } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { trpc, type TrpcOutput } from "@/shared/lib/trpc";

type ReportDetail = TrpcOutput["reports"]["get"];
type Slot = ReportDetail["slots"][number];

function SlotEditor({
  reportId,
  slot,
  frozen,
  busy,
  onSaved,
  onRegenerate,
}: {
  reportId: string;
  slot: Slot;
  frozen: boolean;
  busy: boolean;
  onSaved: () => void;
  onRegenerate: (slug: string, wasEdited: boolean) => void;
}): ReactElement {
  const [text, setText] = useState(slot.text ?? "");
  const save = trpc.reports.updateSlot.useMutation({
    onSuccess: () => {
      toast.success(`Slot “${slot.slug}” salvo.`);
      onSaved();
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  return (
    <div className="flex flex-col gap-2 border-b border-[color:var(--rule)] py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[length:var(--fs-body-sm)]">{slot.slug}</span>
        {slot.edited && <Badge variant="secondary">editado por pessoa</Badge>}
        {slot.text === null && <Badge variant="outline">ainda sem texto</Badge>}
        {slot.numeralFlags.length > 0 && (
          <Badge variant="outline" className="text-[color:var(--negative)]">
            guarda numérica: {slot.numeralFlags.join(", ")}
          </Badge>
        )}
        {slot.refuted.length > 0 && (
          <Badge variant="outline" className="text-[color:var(--negative)]">
            contestado: {String(slot.refuted.length)}
          </Badge>
        )}
        {slot.refuted.length === 0 && slot.verifiedAt !== null && (
          <Badge variant="secondary">verificado</Badge>
        )}
      </div>
      {slot.guideline.length > 0 && (
        <p className="max-w-prose text-[length:var(--fs-body-sm)] italic text-[color:var(--ink-mute)]">
          {slot.guideline}
        </p>
      )}
      {slot.refuted.length > 0 && (
        // The verifier NEVER rewrites (§12.13) — this is what it SAW, for a
        // person to resolve. Editing the slot clears it.
        <ul className="max-w-prose list-disc pl-5 text-[length:var(--fs-body-sm)] text-[color:var(--negative)]">
          {slot.refuted.map((claim, i) => (
            <li key={`${slot.slug}-refuted-${String(i)}`}>
              “{claim.claim}” — {claim.fundamento ?? "sem fundamento registrado"}
            </li>
          ))}
        </ul>
      )}
      <Textarea
        value={text}
        readOnly={frozen}
        className="min-h-[7rem]"
        onChange={(e) => {
          setText(e.target.value);
        }}
      />
      {!frozen && (
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={save.isPending}
            onClick={() => {
              save.mutate({ reportId, slug: slot.slug, text });
            }}
          >
            Salvar texto
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              onRegenerate(slot.slug, slot.edited);
            }}
          >
            Regerar
          </Button>
        </div>
      )}
    </div>
  );
}

export function ReportSlots({
  reportId,
  slots,
  frozen,
  busy,
  onSaved,
  onRegenerate,
}: {
  reportId: string;
  slots: readonly Slot[];
  frozen: boolean;
  busy: boolean;
  onSaved: () => void;
  onRegenerate: (slug: string, wasEdited: boolean) => void;
}): ReactElement {
  if (slots.length === 0) {
    return (
      <p className="py-3 text-[length:var(--fs-body-sm)] italic text-[color:var(--ink-mute)]">
        Este modelo não declara nenhum slot de prosa.
      </p>
    );
  }
  return (
    <div className="flex flex-col">
      {slots.map((slot) => (
        <SlotEditor
          // Keyed on the stored text too, so a regeneration or a reload
          // reseeds the textarea instead of showing stale local state.
          key={`${slot.slug}:${slot.text ?? ""}`}
          reportId={reportId}
          slot={slot}
          frozen={frozen}
          busy={busy}
          onSaved={onSaved}
          onRegenerate={onRegenerate}
        />
      ))}
    </div>
  );
}
