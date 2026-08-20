// Per-row sub-component for ReviewRows. Builds the picker config (one entry
// per classification field) and renders three sub-rows: the main data row,
// a classification picker row driven by ClassificationFieldCell, and (when
// present) the match-suggestion hint.

import { useMemo, type ReactElement } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TableCell, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Eyebrow } from "@/components/ui/eyebrow";
import { trpc, type TrpcOutput } from "@/shared/lib/trpc";
import { formatDate } from "@/shared/lib/format";
import type { UseLovResult } from "@/hooks/use-lov";
import type { UseTenantValuesResult } from "@/hooks/use-tenant-values";
import type { PickerItem } from "@/components/inline-ref-picker";
import { ClassificationFieldCell } from "./ClassificationFieldCell";
import { centsToReais, signedAmountClass } from "./review-rows-helpers";

export type ImportRowData = TrpcOutput["statementImportRows"]["list"][number];

export type ReviewAction = "new" | "match" | "skip";
export type FieldKey =
  "categoryId" | "creditorId" | "paymentMethodId" | "subtypeId" | "businessUnitId";

export type ResolveTarget =
  { kind: "lov-system"; type: string } | { kind: "tenant-value"; tvKind: string };

const MATCH_THRESHOLD = 70;

type CreateProps = Partial<
  Pick<
    React.ComponentProps<typeof ClassificationFieldCell>,
    "onCreateRequested" | "createSuggestion"
  >
>;

function buildCreateProps(f: {
  onCreateRequested?: (name: string) => void;
  createSuggestion?: string;
}): CreateProps {
  const out: CreateProps = {};
  if (f.onCreateRequested !== undefined) out.onCreateRequested = f.onCreateRequested;
  if (f.createSuggestion !== undefined) out.createSuggestion = f.createSuggestion;
  return out;
}

export function ReviewableRow({
  row,
  subtypeLov,
  categoryLov,
  dreGroupLov,
  paymentMethodLov,
  supplierTv,
  customerTv,
  businessUnitTv,
  isSelected,
  onToggleSelect,
  onReview,
  onSetClassification,
  onSetAccrualDate,
  onSetReference,
  onRequestCreateCategory,
  onRequestCreateCreditor,
  onRequestCreatePaymentMethod,
  onRequestCreateSubtype,
  onRequestCreateBusinessUnit,
  onRequestCreateRecurrence,
  creditorCreateSuggestion,
  fetchSuggestions,
}: {
  row: ImportRowData;
  subtypeLov: UseLovResult;
  categoryLov: UseLovResult;
  dreGroupLov: UseLovResult;
  paymentMethodLov: UseLovResult;
  supplierTv: UseTenantValuesResult;
  customerTv: UseTenantValuesResult;
  businessUnitTv: UseTenantValuesResult;
  isSelected: boolean;
  onToggleSelect: () => void;
  onReview: (action: ReviewAction, matchedTransactionId?: string) => void;
  onSetClassification: (field: FieldKey, id: string | null) => void;
  onSetAccrualDate: (accrualDate: string) => void;
  onSetReference: (reference: string | null) => void;
  onRequestCreateCategory: (name: string) => void;
  onRequestCreateCreditor: (kind: "SUPPLIER" | "CUSTOMER", name: string) => void;
  onRequestCreatePaymentMethod: (name: string) => void;
  onRequestCreateSubtype: (name: string) => void;
  onRequestCreateBusinessUnit: (name: string) => void;
  onRequestCreateRecurrence: () => void;
  creditorCreateSuggestion: string;
  fetchSuggestions: (
    rowId: string,
    target: ResolveTarget,
    candidate: string,
  ) => Promise<PickerItem[]>;
}): ReactElement {
  const candidatesQuery = trpc.statementImportRows.candidates.useQuery({ rowId: row.id });
  const candidates = candidatesQuery.data ?? [];
  const topCandidate = candidates[0];
  const hasGoodCandidate = topCandidate !== undefined && topCandidate.score >= MATCH_THRESHOLD;

  // Income rows (positive amount) bill a customer; expense rows pay a supplier.
  // Both kinds land on transactions.creditor_id (FK → tenant_values).
  const creditorKind: "SUPPLIER" | "CUSTOMER" =
    row.actualAmount !== null && Number(row.actualAmount) > 0 ? "CUSTOMER" : "SUPPLIER";
  const creditorTv = creditorKind === "CUSTOMER" ? customerTv : supplierTv;

  const categoryItems = useMemo<PickerItem[]>(() => {
    const dreById = new Map(dreGroupLov.items.map((g) => [g.id, g]));
    return categoryLov.items.map((i) => {
      const dre = i.parentLov !== null ? dreById.get(i.parentLov) : undefined;
      const sublabel = dre !== undefined ? `${dre.code} · ${dre.value}` : i.code;
      return { id: i.id, label: i.value, sublabel };
    });
  }, [categoryLov.items, dreGroupLov.items]);
  const paymentMethodItems = useMemo<PickerItem[]>(
    () => paymentMethodLov.items.map((i) => ({ id: i.id, label: i.value, sublabel: i.code })),
    [paymentMethodLov.items],
  );
  const subtypeItems = useMemo<PickerItem[]>(
    () => subtypeLov.items.map((i) => ({ id: i.id, label: i.value, sublabel: i.code })),
    [subtypeLov.items],
  );
  const creditorItems = useMemo<PickerItem[]>(
    () =>
      creditorTv.items.map((i) => ({
        id: i.id,
        label: i.name,
        ...(i.parent !== null ? { sublabel: i.parent.label } : {}),
      })),
    [creditorTv.items],
  );
  const businessUnitItems = useMemo<PickerItem[]>(
    () =>
      businessUnitTv.items.map((i) => ({
        id: i.id,
        label: i.name,
        ...(i.parent !== null ? { sublabel: i.parent.label } : {}),
      })),
    [businessUnitTv.items],
  );

  const description = row.description ?? "";

  const creditorPlaceholder = creditorKind === "CUSTOMER" ? "Cliente" : "Fornecedor";

  type FieldConfig = {
    key: FieldKey;
    value: string | null;
    items: PickerItem[];
    target: ResolveTarget;
    placeholder: string;
    ariaLabel: string;
    onCreateRequested?: (name: string) => void;
    createSuggestion?: string;
  };
  const fields: FieldConfig[] = [
    {
      key: "categoryId",
      value: row.categoryId,
      items: categoryItems,
      target: { kind: "lov-system", type: "CATEGORY" },
      placeholder: "Categoria",
      ariaLabel: `Categoria da linha ${String(row.lineNumber)}`,
      onCreateRequested: onRequestCreateCategory,
    },
    {
      key: "creditorId",
      value: row.creditorId,
      items: creditorItems,
      target: { kind: "tenant-value", tvKind: creditorKind },
      placeholder: creditorPlaceholder,
      ariaLabel: `${creditorPlaceholder} da linha ${String(row.lineNumber)}`,
      onCreateRequested: (name) => {
        onRequestCreateCreditor(creditorKind, name);
      },
      createSuggestion: creditorCreateSuggestion,
    },
    {
      key: "paymentMethodId",
      value: row.paymentMethodId,
      items: paymentMethodItems,
      target: { kind: "lov-system", type: "PAYMENT_METHOD" },
      placeholder: "Forma de pagamento",
      ariaLabel: `Forma de pagamento da linha ${String(row.lineNumber)}`,
      onCreateRequested: onRequestCreatePaymentMethod,
    },
    {
      key: "subtypeId",
      value: row.subtypeId,
      items: subtypeItems,
      target: { kind: "lov-system", type: "TRANSACTION_SUBTYPE" },
      placeholder: "Subtipo",
      ariaLabel: `Subtipo da linha ${String(row.lineNumber)}`,
      onCreateRequested: onRequestCreateSubtype,
    },
    {
      key: "businessUnitId",
      value: row.businessUnitId,
      items: businessUnitItems,
      target: { kind: "tenant-value", tvKind: "BUSINESS_UNIT" },
      placeholder: "Centro de custo",
      ariaLabel: `Centro de custo da linha ${String(row.lineNumber)}`,
      onCreateRequested: onRequestCreateBusinessUnit,
    },
  ];

  return (
    <>
      <TableRow data-state={isSelected ? "selected" : undefined}>
        <TableCell className="w-10">
          <Checkbox
            checked={isSelected}
            onCheckedChange={onToggleSelect}
            aria-label={`Selecionar linha ${String(row.lineNumber)}`}
          />
        </TableCell>
        <TableCell className="text-[length:var(--fs-eyebrow)] text-[color:var(--ink-mute)] tabular-nums">
          {String(row.lineNumber).padStart(3, "0")}
        </TableCell>
        <TableCell className="tabular-nums text-[color:var(--ink-soft)]">
          {formatDate(row.actualDate)}
        </TableCell>
        <TableCell>
          <Input
            type="date"
            value={row.accrualDate ?? row.actualDate ?? ""}
            onChange={(e) => {
              const next = e.target.value;
              if (next !== "" && next !== row.accrualDate) onSetAccrualDate(next);
            }}
            aria-label={`Competência da linha ${String(row.lineNumber)}`}
            className="h-8 text-[length:var(--fs-body-sm)] w-32"
          />
        </TableCell>
        <TableCell>
          <Input
            type="text"
            defaultValue={row.reference ?? ""}
            onBlur={(e) => {
              const next = e.target.value.trim();
              const current = row.reference ?? "";
              if (next === current) return;
              onSetReference(next.length > 0 ? next.slice(0, 80) : null);
            }}
            maxLength={80}
            aria-label={`Referência da linha ${String(row.lineNumber)}`}
            className="h-8 text-[length:var(--fs-body-sm)] w-32"
          />
        </TableCell>
        <TableCell
          className={`text-right tabular-nums font-[500] ${signedAmountClass(row.actualAmount)}`}
        >
          {centsToReais(row.actualAmount)}
        </TableCell>
        <TableCell className="max-w-[280px] truncate">{row.description}</TableCell>
        <TableCell>
          <DecisionButtons
            isLoading={candidatesQuery.isLoading}
            hasCandidates={candidates.length > 0}
            hasGoodCandidate={hasGoodCandidate}
            onReview={onReview}
            onRequestCreateRecurrence={onRequestCreateRecurrence}
            topCandidateId={topCandidate?.transaction.id}
          />
        </TableCell>
      </TableRow>

      <TableRow className="bg-[color:var(--paper-sink)]/40 hover:bg-[color:var(--paper-sink)]/40">
        <TableCell />
        <TableCell />
        <TableCell colSpan={6} className="py-1.5">
          <div className="flex flex-wrap gap-2 items-center text-[length:var(--fs-body-sm)]">
            <Eyebrow>Classificação</Eyebrow>
            {fields.map((f) => (
              <div key={f.key} className="min-w-[180px]">
                <ClassificationFieldCell
                  rowId={row.id}
                  value={f.value}
                  items={f.items}
                  target={f.target}
                  description={description}
                  placeholder={f.placeholder}
                  ariaLabel={f.ariaLabel}
                  fetchSuggestions={fetchSuggestions}
                  onChange={(id) => {
                    onSetClassification(f.key, id);
                  }}
                  {...buildCreateProps(f)}
                />
              </div>
            ))}
          </div>
        </TableCell>
      </TableRow>

      {topCandidate !== undefined && (
        <SuggestionRow topCandidate={topCandidate} extraCount={candidates.length - 1} />
      )}
    </>
  );
}

function DecisionButtons({
  isLoading,
  hasCandidates,
  hasGoodCandidate,
  onReview,
  onRequestCreateRecurrence,
  topCandidateId,
}: {
  isLoading: boolean;
  hasCandidates: boolean;
  hasGoodCandidate: boolean;
  onReview: (action: ReviewAction, matchedTransactionId?: string) => void;
  onRequestCreateRecurrence: () => void;
  topCandidateId: string | undefined;
}): ReactElement {
  if (isLoading) {
    return (
      <span className="text-[length:var(--fs-eyebrow)] uppercase tracking-[0.1em] text-[color:var(--ink-mute)]">
        Carregando
      </span>
    );
  }
  return (
    <div className="flex gap-1.5">
      {hasCandidates && (
        <Button
          size="sm"
          variant={hasGoodCandidate ? "accent" : "outline"}
          onClick={() => {
            onReview("match", topCandidateId);
          }}
        >
          Conciliar
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          onReview("new");
        }}
      >
        Criar
      </Button>
      <Button size="sm" variant="outline" onClick={onRequestCreateRecurrence}>
        Recorrência
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          onReview("skip");
        }}
      >
        Pular
      </Button>
    </div>
  );
}

type Candidate = {
  transaction: { dueDate: string; forecastAmount: bigint; description: string | null };
  score: number;
};

function SuggestionRow({
  topCandidate,
  extraCount,
}: {
  topCandidate: Candidate;
  extraCount: number;
}): ReactElement {
  return (
    <TableRow className="bg-[color:var(--paper-sink)]/60 hover:bg-[color:var(--paper-sink)]/60">
      <TableCell />
      <TableCell />
      <TableCell
        colSpan={6}
        className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-soft)] py-1.5"
      >
        <span className="inline-flex items-center gap-2">
          <Eyebrow tone="accent">Sugestão</Eyebrow>
          <span className="tabular-nums text-[color:var(--ink-mute)]">
            score {topCandidate.score}
          </span>
          <span className="text-[color:var(--ink-mute)]">·</span>
          <span className="tabular-nums">{formatDate(topCandidate.transaction.dueDate)}</span>
          <span className="text-[color:var(--ink-mute)]">·</span>
          <span className="tabular-nums font-[500] text-[color:var(--ink)]">
            {centsToReais(topCandidate.transaction.forecastAmount)}
          </span>
          <span className="text-[color:var(--ink-mute)]">·</span>
          <span className="italic">{topCandidate.transaction.description ?? "sem descrição"}</span>
          {extraCount > 0 && (
            <span className="text-[color:var(--ink-mute)]">(+{extraCount} outras)</span>
          )}
        </span>
      </TableCell>
    </TableRow>
  );
}
