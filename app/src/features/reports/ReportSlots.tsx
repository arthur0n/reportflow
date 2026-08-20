// app/src/features/reports/ReportSlots.tsx
//
// §5.2 — the prose slots, editable. Saving a slot sets `edited: true` on the
// server (the mutation MEANS edited; the flag is not an input), and the badge
// here is what tells a user that regeneration will now leave this text alone.
//
// The analysis hop that FILLS these arrives with #10. Until then the slots are
// empty and the draft renders a visible placeholder in their place, which is
// exactly how the authoring loop was meant to work: the shell is reviewable
// before any prose exists.

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
  onSaved,
}: {
  reportId: string;
  slot: Slot;
  frozen: boolean;
  onSaved: () => void;
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
      </div>
      {slot.guideline.length > 0 && (
        <p className="max-w-prose text-[length:var(--fs-body-sm)] italic text-[color:var(--ink-mute)]">
          {slot.guideline}
        </p>
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
        <div>
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
        </div>
      )}
    </div>
  );
}

export function ReportSlots({
  reportId,
  slots,
  frozen,
  onSaved,
}: {
  reportId: string;
  slots: readonly Slot[];
  frozen: boolean;
  onSaved: () => void;
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
          onSaved={onSaved}
        />
      ))}
    </div>
  );
}
