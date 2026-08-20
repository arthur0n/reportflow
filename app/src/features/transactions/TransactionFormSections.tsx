import { type Dispatch, type ReactElement, type SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InlineRefPicker, type PickerItem } from "@/components/inline-ref-picker";

type Setter<T> = Dispatch<SetStateAction<T>>;

export function DescriptionField({
  description,
  setDescription,
  onBlur,
}: {
  description: string;
  setDescription: Setter<string>;
  onBlur: () => void;
}): ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="tx-description">Descrição</Label>
      <Input
        id="tx-description"
        value={description}
        onChange={(e) => {
          setDescription(e.target.value);
        }}
        onBlur={onBlur}
        maxLength={1000}
        placeholder="Ex.: Aluguel sala 12 — junho"
      />
    </div>
  );
}

export function ReferenceField({
  reference,
  setReference,
}: {
  reference: string;
  setReference: Setter<string>;
}): ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="tx-reference">Referência (NF, boleto…)</Label>
      <Input
        id="tx-reference"
        value={reference}
        onChange={(e) => {
          setReference(e.target.value);
        }}
        maxLength={80}
      />
    </div>
  );
}

export function SubmitFooter({
  submitError,
  isPending,
  onCancel,
}: {
  submitError: string | null;
  isPending: boolean;
  onCancel: () => void;
}): ReactElement {
  return (
    <>
      {submitError !== null && (
        <p className="text-[length:var(--fs-body-sm)] text-[color:var(--negative)]">
          {submitError}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
          Cancelar
        </Button>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Criando…" : "Criar lançamento"}
        </Button>
      </div>
    </>
  );
}

export type DateAmountSectionProps = {
  accrualDate: string;
  setAccrualDate: Setter<string>;
  dueDate: string;
  setDueDate: Setter<string>;
  actualDate: string;
  setActualDate: Setter<string>;
  forecastReais: string;
  setForecastReais: Setter<string>;
  actualReais: string;
  setActualReais: Setter<string>;
};

export function DateAmountSection({
  accrualDate,
  setAccrualDate,
  dueDate,
  setDueDate,
  actualDate,
  setActualDate,
  forecastReais,
  setForecastReais,
  actualReais,
  setActualReais,
}: DateAmountSectionProps): ReactElement {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tx-accrual">Competência</Label>
          <Input
            id="tx-accrual"
            type="date"
            value={accrualDate}
            onChange={(e) => {
              setAccrualDate(e.target.value);
            }}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tx-due">Vencimento</Label>
          <Input
            id="tx-due"
            type="date"
            value={dueDate}
            onChange={(e) => {
              setDueDate(e.target.value);
            }}
            required
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tx-forecast">Valor previsto (R$)</Label>
          <Input
            id="tx-forecast"
            type="text"
            inputMode="decimal"
            value={forecastReais}
            onChange={(e) => {
              setForecastReais(e.target.value);
            }}
            placeholder="0,00"
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tx-actual">Valor realizado (R$, opcional)</Label>
          <Input
            id="tx-actual"
            type="text"
            inputMode="decimal"
            value={actualReais}
            onChange={(e) => {
              setActualReais(e.target.value);
            }}
            placeholder="0,00"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="tx-actual-date">Data realizada (opcional)</Label>
        <Input
          id="tx-actual-date"
          type="date"
          value={actualDate}
          onChange={(e) => {
            setActualDate(e.target.value);
          }}
        />
      </div>
    </>
  );
}

export type ClassifierSectionProps = {
  showCreditor: boolean;
  creditorKindLabel: string;
  creditorPlaceholder: string;
  description: string;
  creditorId: string | null;
  setCreditorId: Setter<string | null>;
  creditorItems: PickerItem[];
  creditorSuggestions: PickerItem[];
  onCreateCreditor: (name: string) => void;

  showCategory: boolean;
  categoryId: string | null;
  setCategoryId: Setter<string | null>;
  categoryItems: PickerItem[];
  categorySuggestions: PickerItem[];
  onCreateCategory: (name: string) => void;

  paymentMethodId: string | null;
  setPaymentMethodId: Setter<string | null>;
  paymentMethodItems: PickerItem[];
  paymentMethodSuggestions: PickerItem[];
  onCreatePaymentMethod: (name: string) => void;

  subtypeId: string | null;
  setSubtypeId: Setter<string | null>;
  subtypeItems: PickerItem[];
  subtypeSuggestions: PickerItem[];
  onCreateSubtype: (name: string) => void;

  cashBoxId: string | null;
  setCashBoxId: Setter<string | null>;
  cashBoxItems: PickerItem[];
  onCreateCashBox: (name: string) => void;

  businessUnitId: string | null;
  setBusinessUnitId: Setter<string | null>;
  businessUnitItems: PickerItem[];
  onCreateBusinessUnit: (name: string) => void;

  statusId: string | null;
  setStatusId: Setter<string | null>;
  statusItems: PickerItem[];
};

export function ClassifierSection(props: ClassifierSectionProps): ReactElement {
  return (
    <>
      {props.showCreditor && (
        <div className="flex flex-col gap-1.5">
          <Label>{props.creditorKindLabel}</Label>
          <InlineRefPicker
            value={props.creditorId}
            items={props.creditorItems}
            suggestions={props.creditorSuggestions}
            onChange={props.setCreditorId}
            placeholder={props.creditorPlaceholder}
            onCreateRequested={props.onCreateCreditor}
            createSuggestion={props.description.trim()}
          />
        </div>
      )}

      {props.showCategory && (
        <div className="flex flex-col gap-1.5">
          <Label>Categoria</Label>
          <InlineRefPicker
            value={props.categoryId}
            items={props.categoryItems}
            suggestions={props.categorySuggestions}
            onChange={props.setCategoryId}
            placeholder="Selecionar categoria…"
            onCreateRequested={props.onCreateCategory}
          />
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <Label>Forma de pagamento</Label>
        <InlineRefPicker
          value={props.paymentMethodId}
          items={props.paymentMethodItems}
          suggestions={props.paymentMethodSuggestions}
          onChange={props.setPaymentMethodId}
          placeholder="Selecionar forma de pagamento…"
          onCreateRequested={props.onCreatePaymentMethod}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Subtipo (opcional)</Label>
        <InlineRefPicker
          value={props.subtypeId}
          items={props.subtypeItems}
          suggestions={props.subtypeSuggestions}
          onChange={props.setSubtypeId}
          placeholder="Selecionar subtipo…"
          onCreateRequested={props.onCreateSubtype}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label>Caixa</Label>
          <InlineRefPicker
            value={props.cashBoxId}
            items={props.cashBoxItems}
            onChange={props.setCashBoxId}
            placeholder="Selecionar caixa…"
            onCreateRequested={props.onCreateCashBox}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Unidade de negócio</Label>
          <InlineRefPicker
            value={props.businessUnitId}
            items={props.businessUnitItems}
            onChange={props.setBusinessUnitId}
            placeholder="Selecionar unidade…"
            onCreateRequested={props.onCreateBusinessUnit}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Status (opcional — default automático)</Label>
        <InlineRefPicker
          value={props.statusId}
          items={props.statusItems}
          onChange={props.setStatusId}
          placeholder="Selecionar status…"
        />
      </div>
    </>
  );
}
