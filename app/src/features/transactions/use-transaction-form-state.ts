// Owns the 17-field transaction form state shared by every host that creates
// a transaction (manual CRUD modal, recurrence dialog from imports row +
// transaction row, future report-tab callers, …). Re-seeds from
// `initialValues` on `open` transitions; exposes `buildSourcePayload` that
// returns `{ ok, value | error }` so the host owns submit + routing.
//
// Companion: `features/recurrences/use-recurrence-config-state.ts` for the
// orthogonal recurrence config (mode + pattern + count). Hosts that opt in
// compose both hooks; hosts that don't need recurrence use this one alone.

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import {
  TRANSACTION_TYPE_ATTRS,
  type TransactionTypeCode,
} from "@shared/constants/transaction-types";
import { amountSign, reaisToCents, todayIso } from "./transaction-form-utils";

export type TransactionFormInitialValues = {
  description?: string;
  reference?: string;
  accrualDate?: string;
  dueDate?: string;
  actualDate?: string;
  forecastReais?: string;
  actualReais?: string;
  creditorId?: string | null;
  categoryId?: string | null;
  paymentMethodId?: string | null;
  subtypeId?: string | null;
  cashBoxId?: string | null;
  businessUnitId?: string | null;
  statusId?: string | null;
};

type StringSetter = Dispatch<SetStateAction<string>>;
type NullableStringSetter = Dispatch<SetStateAction<string | null>>;

export type TransactionFormState = {
  description: string;
  setDescription: StringSetter;
  reference: string;
  setReference: StringSetter;
  accrualDate: string;
  setAccrualDate: StringSetter;
  dueDate: string;
  setDueDate: StringSetter;
  actualDate: string;
  setActualDate: StringSetter;
  forecastReais: string;
  setForecastReais: StringSetter;
  actualReais: string;
  setActualReais: StringSetter;
  creditorId: string | null;
  setCreditorId: NullableStringSetter;
  categoryId: string | null;
  setCategoryId: NullableStringSetter;
  paymentMethodId: string | null;
  setPaymentMethodId: NullableStringSetter;
  subtypeId: string | null;
  setSubtypeId: NullableStringSetter;
  cashBoxId: string | null;
  setCashBoxId: NullableStringSetter;
  businessUnitId: string | null;
  setBusinessUnitId: NullableStringSetter;
  statusId: string | null;
  setStatusId: NullableStringSetter;
  showCreditor: boolean;
  showCategory: boolean;
  buildSourcePayload: (
    transactionTypeId: string,
  ) => { ok: true; value: SourcePayload } | { ok: false; error: string };
};

export type SourcePayload = {
  transactionTypeId: string;
  forecastAmount: number;
  accrualDate: string;
  dueDate: string;
  actualDate?: string;
  actualAmount?: number;
  description?: string;
  reference?: string;
  creditorId?: string;
  categoryId?: string;
  paymentMethodId?: string;
  subtypeId?: string;
  cashBoxId?: string;
  businessUnitId?: string;
  statusId?: string;
};

export function useTransactionFormState(args: {
  open: boolean;
  transactionTypeCode: TransactionTypeCode;
  initialValues?: TransactionFormInitialValues;
}): TransactionFormState {
  const { open, transactionTypeCode, initialValues } = args;

  const attrs = TRANSACTION_TYPE_ATTRS[transactionTypeCode];
  const showCreditor = attrs.requiresCreditor || transactionTypeCode === "REVENUE";
  const showCategory = attrs.requiresCategory || transactionTypeCode === "REVENUE";

  const fields = useTransactionFieldStates();

  // useState setters are stable across renders, so seeding only depends on
  // the open transition and a fresh initialValues reference.
  useEffect(() => {
    if (!open) return;
    seedFromInitial(initialValues, fieldsToSetters(fields));
  }, [open, initialValues, fields]);

  return {
    ...fields,
    showCreditor,
    showCategory,
    buildSourcePayload: (transactionTypeId) =>
      buildSourcePayload(fields, transactionTypeCode, transactionTypeId),
  };
}

type FieldStates = {
  description: string;
  setDescription: StringSetter;
  reference: string;
  setReference: StringSetter;
  accrualDate: string;
  setAccrualDate: StringSetter;
  dueDate: string;
  setDueDate: StringSetter;
  actualDate: string;
  setActualDate: StringSetter;
  forecastReais: string;
  setForecastReais: StringSetter;
  actualReais: string;
  setActualReais: StringSetter;
  creditorId: string | null;
  setCreditorId: NullableStringSetter;
  categoryId: string | null;
  setCategoryId: NullableStringSetter;
  paymentMethodId: string | null;
  setPaymentMethodId: NullableStringSetter;
  subtypeId: string | null;
  setSubtypeId: NullableStringSetter;
  cashBoxId: string | null;
  setCashBoxId: NullableStringSetter;
  businessUnitId: string | null;
  setBusinessUnitId: NullableStringSetter;
  statusId: string | null;
  setStatusId: NullableStringSetter;
};

function useTransactionFieldStates(): FieldStates {
  const today = todayIso();
  const [description, setDescription] = useState("");
  const [reference, setReference] = useState("");
  const [accrualDate, setAccrualDate] = useState(today);
  const [dueDate, setDueDate] = useState(today);
  const [actualDate, setActualDate] = useState("");
  const [forecastReais, setForecastReais] = useState("");
  const [actualReais, setActualReais] = useState("");
  const [creditorId, setCreditorId] = useState<string | null>(null);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [paymentMethodId, setPaymentMethodId] = useState<string | null>(null);
  const [subtypeId, setSubtypeId] = useState<string | null>(null);
  const [cashBoxId, setCashBoxId] = useState<string | null>(null);
  const [businessUnitId, setBusinessUnitId] = useState<string | null>(null);
  const [statusId, setStatusId] = useState<string | null>(null);
  return {
    description,
    setDescription,
    reference,
    setReference,
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
    creditorId,
    setCreditorId,
    categoryId,
    setCategoryId,
    paymentMethodId,
    setPaymentMethodId,
    subtypeId,
    setSubtypeId,
    cashBoxId,
    setCashBoxId,
    businessUnitId,
    setBusinessUnitId,
    statusId,
    setStatusId,
  };
}

type Setters = {
  setDescription: StringSetter;
  setReference: StringSetter;
  setAccrualDate: StringSetter;
  setDueDate: StringSetter;
  setActualDate: StringSetter;
  setForecastReais: StringSetter;
  setActualReais: StringSetter;
  setCreditorId: NullableStringSetter;
  setCategoryId: NullableStringSetter;
  setPaymentMethodId: NullableStringSetter;
  setSubtypeId: NullableStringSetter;
  setCashBoxId: NullableStringSetter;
  setBusinessUnitId: NullableStringSetter;
  setStatusId: NullableStringSetter;
};

function fieldsToSetters(f: FieldStates): Setters {
  return {
    setDescription: f.setDescription,
    setReference: f.setReference,
    setAccrualDate: f.setAccrualDate,
    setDueDate: f.setDueDate,
    setActualDate: f.setActualDate,
    setForecastReais: f.setForecastReais,
    setActualReais: f.setActualReais,
    setCreditorId: f.setCreditorId,
    setCategoryId: f.setCategoryId,
    setPaymentMethodId: f.setPaymentMethodId,
    setSubtypeId: f.setSubtypeId,
    setCashBoxId: f.setCashBoxId,
    setBusinessUnitId: f.setBusinessUnitId,
    setStatusId: f.setStatusId,
  };
}

function buildSourcePayload(
  f: FieldStates,
  transactionTypeCode: TransactionTypeCode,
  transactionTypeId: string,
): { ok: true; value: SourcePayload } | { ok: false; error: string } {
  const forecastCents = reaisToCents(f.forecastReais);
  if (forecastCents === null || forecastCents === 0) {
    return { ok: false, error: "Informe o valor previsto." };
  }
  if (f.dueDate < f.accrualDate) {
    return { ok: false, error: "Vencimento não pode ser anterior à competência." };
  }
  const sign = amountSign(transactionTypeCode);
  const actualCents = f.actualReais.length > 0 ? reaisToCents(f.actualReais) : null;
  const value: SourcePayload = {
    transactionTypeId,
    forecastAmount: forecastCents * sign,
    accrualDate: f.accrualDate,
    dueDate: f.dueDate,
    ...(f.actualDate.length > 0 ? { actualDate: f.actualDate } : {}),
    ...(actualCents !== null ? { actualAmount: actualCents * sign } : {}),
    ...(f.description.trim().length > 0 ? { description: f.description.trim() } : {}),
    ...(f.reference.trim().length > 0 ? { reference: f.reference.trim() } : {}),
    ...nonNullFks({
      creditorId: f.creditorId,
      categoryId: f.categoryId,
      paymentMethodId: f.paymentMethodId,
      subtypeId: f.subtypeId,
      cashBoxId: f.cashBoxId,
      businessUnitId: f.businessUnitId,
      statusId: f.statusId,
    }),
  };
  return { ok: true, value };
}

function seedFromInitial(initial: TransactionFormInitialValues | undefined, s: Setters): void {
  const defaults = withDefaults(initial);
  s.setDescription(defaults.description);
  s.setReference(defaults.reference);
  s.setAccrualDate(defaults.accrualDate);
  s.setDueDate(defaults.dueDate);
  s.setActualDate(defaults.actualDate);
  s.setForecastReais(defaults.forecastReais);
  s.setActualReais(defaults.actualReais);
  s.setCreditorId(defaults.creditorId);
  s.setCategoryId(defaults.categoryId);
  s.setPaymentMethodId(defaults.paymentMethodId);
  s.setSubtypeId(defaults.subtypeId);
  s.setCashBoxId(defaults.cashBoxId);
  s.setBusinessUnitId(defaults.businessUnitId);
  s.setStatusId(defaults.statusId);
}

type SeedDefaults = {
  description: string;
  reference: string;
  accrualDate: string;
  dueDate: string;
  actualDate: string;
  forecastReais: string;
  actualReais: string;
  creditorId: string | null;
  categoryId: string | null;
  paymentMethodId: string | null;
  subtypeId: string | null;
  cashBoxId: string | null;
  businessUnitId: string | null;
  statusId: string | null;
};

function withDefaults(initial: TransactionFormInitialValues | undefined): SeedDefaults {
  const i = initial ?? {};
  return { ...stringDefaults(i), ...fkDefaults(i) };
}

function stringDefaults(
  i: TransactionFormInitialValues,
): Pick<
  SeedDefaults,
  | "description"
  | "reference"
  | "accrualDate"
  | "dueDate"
  | "actualDate"
  | "forecastReais"
  | "actualReais"
> {
  const today = todayIso();
  const accrualDate = i.accrualDate ?? today;
  return {
    description: i.description ?? "",
    reference: i.reference ?? "",
    accrualDate,
    dueDate: i.dueDate ?? accrualDate,
    actualDate: i.actualDate ?? "",
    forecastReais: i.forecastReais ?? "",
    actualReais: i.actualReais ?? "",
  };
}

function fkDefaults(
  i: TransactionFormInitialValues,
): Pick<
  SeedDefaults,
  | "creditorId"
  | "categoryId"
  | "paymentMethodId"
  | "subtypeId"
  | "cashBoxId"
  | "businessUnitId"
  | "statusId"
> {
  return {
    creditorId: i.creditorId ?? null,
    categoryId: i.categoryId ?? null,
    paymentMethodId: i.paymentMethodId ?? null,
    subtypeId: i.subtypeId ?? null,
    cashBoxId: i.cashBoxId ?? null,
    businessUnitId: i.businessUnitId ?? null,
    statusId: i.statusId ?? null,
  };
}

function nonNullFks(fks: Record<string, string | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fks)) {
    if (value !== null) out[key] = value;
  }
  return out;
}
