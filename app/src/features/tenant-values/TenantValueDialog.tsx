import { useEffect, useState, type ReactElement } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { trpc, type TrpcOutput } from "@/shared/lib/trpc";
import { useLov } from "@/hooks/use-lov";
import { toast } from "sonner";
import {
  TENANT_VALUE_KIND_CONFIG,
  type TenantValueKind,
} from "@shared/constants/tenant-value-kinds";
import { LovSuggestionsView, type LovSuggestionsItem } from "@/components/lov/SuggestionsView";

type TenantValueRow = TrpcOutput["tenantValues"]["list"][number];

const NO_PARENT = "__none__";
const NO_BANK = "__none__";

/** Cash boxes whose parent CASH_BOX_TYPE is 'bank' must reference a BANK_SLUG. */
function bankPickerVisible(kind: TenantValueKind, parentValue: string): boolean {
  return kind === "CASH_BOX" && parentValue === "bank";
}

export function TenantValueDialog({
  kind,
  tenantValue,
  open,
  onOpenChange,
  initialName,
  initialParentValue,
  initialDescription,
  onCreated,
}: {
  kind: TenantValueKind;
  tenantValue: TenantValueRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialName?: string;
  initialParentValue?: string;
  initialDescription?: string;
  onCreated?: (id: string) => void;
}): ReactElement {
  const utils = trpc.useUtils();
  const cfg = TENANT_VALUE_KIND_CONFIG[kind];
  const isEdit = tenantValue !== null;

  const parentLovType = cfg.parent.source === "none" ? "" : cfg.parent.lovType;
  const parentOptions = useLov(parentLovType);
  const bankOptions = useLov("BANK_SLUG");

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  // lov-tenant uses uuid; lov-system uses code; both stored as a single string.
  const [parentValue, setParentValue] = useState<string>(NO_PARENT);
  const [bankSlugId, setBankSlugId] = useState<string>(NO_BANK);
  const [suggestions, setSuggestions] = useState<LovSuggestionsItem[] | null>(null);

  const showBank = bankPickerVisible(kind, parentValue);

  const txCountQuery = trpc.tenantValues.transactionsCount.useQuery(
    tenantValue ? { kind, ids: [tenantValue.id] } : { kind, ids: [""] },
    { enabled: isEdit && open && cfg.parentLockedAfterUse },
  );
  const txCount = txCountQuery.data?.[0];
  const parentLocked =
    cfg.parentLockedAfterUse &&
    txCount !== undefined &&
    (txCount.activeCount > 0 || txCount.inactiveCount > 0);

  useEffect(() => {
    if (!open) return;
    if (tenantValue) {
      setName(tenantValue.name);
      setDescription(tenantValue.description ?? "");
      if (cfg.parent.source === "lov-tenant") {
        setParentValue(tenantValue.parent?.id ?? NO_PARENT);
      } else if (cfg.parent.source === "lov-system") {
        setParentValue(tenantValue.parent?.code ?? NO_PARENT);
      } else {
        setParentValue(NO_PARENT);
      }
      setBankSlugId(tenantValue.bank?.id ?? NO_BANK);
    } else {
      setName(initialName ?? "");
      setDescription(initialDescription ?? "");
      setParentValue(initialParentValue ?? NO_PARENT);
      setBankSlugId(NO_BANK);
    }
    setSuggestions(null);
  }, [open, tenantValue, cfg.parent.source, initialName, initialParentValue, initialDescription]);

  const create = trpc.tenantValues.create.useMutation({
    onSuccess: (result) => {
      if (result.kind === "suggestions") {
        // tenant_values similarity matches are always same-tenant rows, so
        // every match is selectable as "tenant-self" in the suggestions view.
        setSuggestions(
          result.matches.map((m) => ({
            id: m.id,
            value: m.value,
            similarity: m.similarity,
            source: "tenant-self",
          })),
        );
        return;
      }
      void utils.tenantValues.invalidate();
      toast.success(`${cfg.labelOne} criado.`);
      onCreated?.(result.row.id);
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  const update = trpc.tenantValues.update.useMutation({
    onSuccess: () => {
      void utils.tenantValues.invalidate();
      toast.success(`${cfg.labelOne} atualizado.`);
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error(err.message);
    },
  });

  function commonFields(): {
    parentField: { parentLov?: string | null } | { parentLovCode?: string } | object;
    descriptionField: { description?: string | null };
    bankField: { bankSlugId: string | null };
  } {
    const parentField =
      cfg.parent.source === "lov-tenant"
        ? { parentLov: parentValue === NO_PARENT ? null : parentValue }
        : cfg.parent.source === "lov-system"
          ? parentValue === NO_PARENT
            ? {}
            : { parentLovCode: parentValue }
          : {};
    const descriptionField = cfg.showDescription
      ? { description: description.trim().length > 0 ? description.trim() : null }
      : {};
    const bankField = { bankSlugId: showBank && bankSlugId !== NO_BANK ? bankSlugId : null };
    return { parentField, descriptionField, bankField };
  }

  function buildCreatePayload(extras: { confirmedDespiteSuggestions?: boolean } = {}): {
    kind: TenantValueKind;
    name: string;
    description?: string | null;
    parentLov?: string | null;
    parentLovCode?: string;
    bankSlugId: string | null;
    confirmedDespiteSuggestions?: boolean;
  } {
    const { parentField, descriptionField, bankField } = commonFields();
    return {
      kind,
      name: name.trim(),
      ...descriptionField,
      ...parentField,
      ...bankField,
      ...(extras.confirmedDespiteSuggestions === true ? { confirmedDespiteSuggestions: true } : {}),
    };
  }

  function handleSubmit(e: React.FormEvent): void {
    e.preventDefault();
    const trimmedName = name.trim();
    if (trimmedName.length < 1) return;
    if (showBank && bankSlugId === NO_BANK) return;

    if (isEdit) {
      const { parentField, descriptionField, bankField } = commonFields();
      update.mutate({
        id: tenantValue.id,
        name: trimmedName,
        ...descriptionField,
        ...parentField,
        ...bankField,
      });
      return;
    }

    create.mutate(buildCreatePayload());
  }

  function handlePickSuggestion(item: LovSuggestionsItem): void {
    toast.info(`Este ${cfg.labelOne.toLowerCase()} já está cadastrado.`);
    void utils.tenantValues.invalidate();
    onCreated?.(item.id);
    onOpenChange(false);
  }

  function handleConfirmCreate(): void {
    create.mutate(buildCreatePayload({ confirmedDespiteSuggestions: true }));
  }

  const pending = create.isPending || update.isPending;
  const submitLabel = isEdit ? (pending ? "Salvando…" : "Salvar") : pending ? "Criando…" : "Criar";
  const dialogTitle = isEdit ? `Editar ${cfg.labelOne.toLowerCase()}` : `Novo ${cfg.labelOne}`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
        </DialogHeader>
        {suggestions !== null ? (
          <LovSuggestionsView
            candidateName={name.trim()}
            suggestions={suggestions}
            onPick={handlePickSuggestion}
            onConfirmCreate={handleConfirmCreate}
            onCancel={() => {
              setSuggestions(null);
            }}
            isPending={create.isPending}
          />
        ) : (
          <FormBody
            cfg={cfg}
            kind={kind}
            name={name}
            setName={setName}
            description={description}
            setDescription={setDescription}
            parentValue={parentValue}
            setParentValue={setParentValue}
            parentOptions={parentOptions.items}
            parentLocked={parentLocked}
            bankSlugId={bankSlugId}
            setBankSlugId={setBankSlugId}
            bankOptions={[...bankOptions.items].sort((a, b) =>
              a.value.localeCompare(b.value, "pt-BR"),
            )}
            showBank={showBank}
            pending={pending}
            submitLabel={submitLabel}
            onSubmit={handleSubmit}
            onCancel={() => {
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

type LovOpt = { id: string; code: string; value: string };

function FormBody(props: {
  cfg: (typeof TENANT_VALUE_KIND_CONFIG)[TenantValueKind];
  kind: TenantValueKind;
  name: string;
  setName: (v: string) => void;
  description: string;
  setDescription: (v: string) => void;
  parentValue: string;
  setParentValue: (v: string) => void;
  parentOptions: LovOpt[];
  parentLocked: boolean;
  bankSlugId: string;
  setBankSlugId: (v: string) => void;
  bankOptions: LovOpt[];
  showBank: boolean;
  pending: boolean;
  submitLabel: string;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
}): ReactElement {
  const {
    cfg,
    kind,
    name,
    setName,
    description,
    setDescription,
    parentValue,
    setParentValue,
    parentOptions,
    parentLocked,
    bankSlugId,
    setBankSlugId,
    bankOptions,
    showBank,
    pending,
    submitLabel,
    onSubmit,
    onCancel,
  } = props;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="tv-name">Nome</Label>
        <Input
          id="tv-name"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
          }}
          maxLength={200}
          required
          autoFocus
        />
      </div>

      {cfg.parent.source !== "none" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tv-parent">
            {cfg.parentLabel}
            {cfg.parent.required ? "" : " (opcional)"}
          </Label>
          <Select
            value={parentValue}
            onValueChange={(next) => {
              setParentValue(next);
              if (!bankPickerVisible(kind, next)) setBankSlugId(NO_BANK);
            }}
            disabled={parentLocked}
          >
            <SelectTrigger id="tv-parent">
              <SelectValue placeholder={cfg.parent.required ? "Selecione" : "Nenhuma"} />
            </SelectTrigger>
            <SelectContent>
              {!cfg.parent.required && <SelectItem value={NO_PARENT}>Nenhuma</SelectItem>}
              {parentOptions.map((opt) => (
                <SelectItem
                  key={opt.id}
                  value={cfg.parent.source === "lov-tenant" ? opt.id : opt.code}
                >
                  {opt.value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {parentLocked && (
            <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
              Tipo imutável após primeiro uso.
            </p>
          )}
        </div>
      )}

      {showBank && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tv-bank">Banco</Label>
          <Select value={bankSlugId} onValueChange={setBankSlugId}>
            <SelectTrigger id="tv-bank">
              <SelectValue placeholder="Selecione" />
            </SelectTrigger>
            <SelectContent>
              {bankOptions.map((opt) => (
                <SelectItem key={opt.id} value={opt.id}>
                  {opt.value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {cfg.showDescription && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tv-description">Observações (opcional)</Label>
          <Textarea
            id="tv-description"
            value={description}
            onChange={(e) => {
              setDescription(e.target.value);
            }}
            maxLength={1000}
            rows={3}
          />
        </div>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pending}>
          Cancelar
        </Button>
        <Button
          type="submit"
          disabled={pending || name.trim().length < 1 || (showBank && bankSlugId === NO_BANK)}
        >
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
