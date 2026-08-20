// Renders the full transaction-shape form body — description, date/amount,
// classifiers, reference — owning its own picker data fetching, picker-item
// shaping, suggestion engine + on-blur auto-fill. Hosts pass: the form state
// hook result, the transaction type, and a `setQuickCreate` callback for the
// "+ Criar" affordances on classifier pickers (the host renders QuickCreateHost
// itself to keep the host in charge of which kinds it allows).
//
// This is the shared body composed by every host that creates/edits a
// transaction-shape: CreateTransactionDialog (manual CRUD), CreateRecurrenceDialog
// (imports row + transaction row), future report-tab hosts.

import { useMemo, useState, type ReactElement } from "react";
import { type PickerItem } from "@/components/inline-ref-picker";
import { useLov } from "@/hooks/use-lov";
import { useTenantValues } from "@/hooks/use-tenant-values";
import { trpc } from "@/shared/lib/trpc";
import type { TransactionTypeCode } from "@shared/constants/transaction-types";
import {
  ClassifierSection,
  DateAmountSection,
  DescriptionField,
  ReferenceField,
} from "./TransactionFormSections";
import { creditorKindFor, pickerItemsFromLov, pickerItemsFromTv } from "./transaction-form-utils";
import { autoFillIdFor, suggestionsFromOutcome, type SuggestProposal } from "./suggest-apply";
import type { QuickCreateState } from "./QuickCreateHost";
import type { TransactionFormState } from "./use-transaction-form-state";

export function TransactionFormFields({
  form,
  transactionTypeCode,
  setQuickCreate,
}: {
  form: TransactionFormState;
  transactionTypeCode: TransactionTypeCode;
  setQuickCreate: (state: QuickCreateState) => void;
}): ReactElement {
  const utils = trpc.useUtils();
  const subtypes = useLov("TRANSACTION_SUBTYPE");
  const categories = useLov("CATEGORY");
  const paymentMethods = useLov("PAYMENT_METHOD");
  const statuses = useLov("TRANSACTION_STATUS");

  const creditorKind = creditorKindFor(transactionTypeCode);
  const creditorList = useTenantValues({ kind: creditorKind });
  const cashBoxes = useTenantValues({ kind: "CASH_BOX" });
  const businessUnits = useTenantValues({ kind: "BUSINESS_UNIT" });

  const [proposal, setProposal] = useState<SuggestProposal | null>(null);

  const categoryItems = useMemo(() => pickerItemsFromLov(categories.items), [categories.items]);
  const subtypeItems = useMemo(() => pickerItemsFromLov(subtypes.items), [subtypes.items]);
  const paymentMethodItems = useMemo(
    () => pickerItemsFromLov(paymentMethods.items),
    [paymentMethods.items],
  );
  const statusItems = useMemo(() => pickerItemsFromLov(statuses.items), [statuses.items]);
  const creditorItems = useMemo(() => pickerItemsFromTv(creditorList.items), [creditorList.items]);
  const cashBoxItems = useMemo(() => pickerItemsFromTv(cashBoxes.items), [cashBoxes.items]);
  const businessUnitItems = useMemo(
    () => pickerItemsFromTv(businessUnits.items),
    [businessUnits.items],
  );

  const credKey = creditorKind === "SUPPLIER" ? "tv:SUPPLIER" : "tv:CUSTOMER";
  const categorySuggestions = suggestionsFromOutcome(
    proposal?.["lov:CATEGORY"],
    useMemo(() => setOf(categoryItems), [categoryItems]),
  );
  const subtypeSuggestions = suggestionsFromOutcome(
    proposal?.["lov:TRANSACTION_SUBTYPE"],
    useMemo(() => setOf(subtypeItems), [subtypeItems]),
  );
  const paymentMethodSuggestions = suggestionsFromOutcome(
    proposal?.["lov:PAYMENT_METHOD"],
    useMemo(() => setOf(paymentMethodItems), [paymentMethodItems]),
  );
  const creditorSuggestions = suggestionsFromOutcome(
    proposal?.[credKey],
    useMemo(() => setOf(creditorItems), [creditorItems]),
  );

  async function handleDescriptionBlur(): Promise<void> {
    const trimmed = form.description.trim();
    if (trimmed.length < 3) return;
    try {
      const next = await utils.transactions.suggest.fetch({ description: trimmed });
      setProposal(next);
      autoFillFromProposal({
        form,
        proposal: next,
        credKey,
        showCreditor: form.showCreditor,
        showCategory: form.showCategory,
      });
    } catch {
      // best-effort
    }
  }

  return (
    <>
      <DescriptionField
        description={form.description}
        setDescription={form.setDescription}
        onBlur={() => {
          void handleDescriptionBlur();
        }}
      />
      <DateAmountSection
        accrualDate={form.accrualDate}
        setAccrualDate={form.setAccrualDate}
        dueDate={form.dueDate}
        setDueDate={form.setDueDate}
        actualDate={form.actualDate}
        setActualDate={form.setActualDate}
        forecastReais={form.forecastReais}
        setForecastReais={form.setForecastReais}
        actualReais={form.actualReais}
        setActualReais={form.setActualReais}
      />
      <ClassifierSection
        showCreditor={form.showCreditor}
        creditorKindLabel={creditorKind === "SUPPLIER" ? "Fornecedor" : "Cliente"}
        creditorPlaceholder={
          creditorKind === "SUPPLIER" ? "Selecionar fornecedor…" : "Selecionar cliente…"
        }
        description={form.description}
        creditorId={form.creditorId}
        setCreditorId={form.setCreditorId}
        creditorItems={creditorItems}
        creditorSuggestions={creditorSuggestions}
        onCreateCreditor={(name) => {
          setQuickCreate({
            kind: creditorKind === "SUPPLIER" ? "supplier" : "customer",
            name,
          });
        }}
        showCategory={form.showCategory}
        categoryId={form.categoryId}
        setCategoryId={form.setCategoryId}
        categoryItems={categoryItems}
        categorySuggestions={categorySuggestions}
        onCreateCategory={(name) => {
          setQuickCreate({ kind: "category", name });
        }}
        paymentMethodId={form.paymentMethodId}
        setPaymentMethodId={form.setPaymentMethodId}
        paymentMethodItems={paymentMethodItems}
        paymentMethodSuggestions={paymentMethodSuggestions}
        onCreatePaymentMethod={(name) => {
          setQuickCreate({ kind: "paymentMethod", name });
        }}
        subtypeId={form.subtypeId}
        setSubtypeId={form.setSubtypeId}
        subtypeItems={subtypeItems}
        subtypeSuggestions={subtypeSuggestions}
        onCreateSubtype={(name) => {
          setQuickCreate({ kind: "subtype", name });
        }}
        cashBoxId={form.cashBoxId}
        setCashBoxId={form.setCashBoxId}
        cashBoxItems={cashBoxItems}
        onCreateCashBox={(name) => {
          setQuickCreate({ kind: "cashBox", name });
        }}
        businessUnitId={form.businessUnitId}
        setBusinessUnitId={form.setBusinessUnitId}
        businessUnitItems={businessUnitItems}
        onCreateBusinessUnit={(name) => {
          setQuickCreate({ kind: "businessUnit", name });
        }}
        statusId={form.statusId}
        setStatusId={form.setStatusId}
        statusItems={statusItems}
      />
      <ReferenceField reference={form.reference} setReference={form.setReference} />
    </>
  );
}

function setOf(items: ReadonlyArray<PickerItem>): Set<string> {
  return new Set(items.map((i) => i.id));
}

/**
 * Apply auto-fill from a fresh suggest proposal to any classifier the user
 * hasn't picked yet. Setters are stable; calling them inside this helper from
 * the description-blur handler is safe.
 */
function autoFillFromProposal(args: {
  form: TransactionFormState;
  proposal: SuggestProposal;
  credKey: "tv:SUPPLIER" | "tv:CUSTOMER";
  showCreditor: boolean;
  showCategory: boolean;
}): void {
  const { form, proposal, credKey, showCreditor, showCategory } = args;
  const pmAuto = autoFillIdFor(proposal["lov:PAYMENT_METHOD"]);
  if (pmAuto !== null && form.paymentMethodId === null) form.setPaymentMethodId(pmAuto);
  const catAuto = autoFillIdFor(proposal["lov:CATEGORY"]);
  if (catAuto !== null && form.categoryId === null && showCategory) form.setCategoryId(catAuto);
  const subAuto = autoFillIdFor(proposal["lov:TRANSACTION_SUBTYPE"]);
  if (subAuto !== null && form.subtypeId === null) form.setSubtypeId(subAuto);
  const credAuto = autoFillIdFor(proposal[credKey]);
  if (credAuto !== null && form.creditorId === null && showCreditor) form.setCreditorId(credAuto);
}
