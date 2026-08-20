import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Link } from "wouter";
import { Settings2, TrendingDown, TrendingUp, ArrowLeftRight } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/button";
import { Eyebrow } from "@/components/ui/eyebrow";
import { TablePagination } from "@/components/ui/table-pagination";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isPageSize, usePagination, type PageSize } from "@/hooks/use-pagination";
import { trpc, type TrpcOutput } from "@/shared/lib/trpc";
import {
  COLUMNS,
  totalsFrom,
  type Column,
  type ColumnKey,
} from "@/components/transactions/columns";
import { TransactionsLedgerTable } from "@/components/transactions/TransactionsLedgerTable";
import { TotalsInline } from "@/components/transactions/TotalsInline";
import { CreateTransactionDialog } from "@/features/transactions/CreateTransactionDialog";
import { CreateRecurrenceDialog } from "@/features/recurrences/CreateRecurrenceDialog";
import { FiltrosButton } from "@/features/transactions/TransactionFilters";
import {
  applyFilters,
  type Filters,
  type SavedFilter,
  DEFAULT_FILTERS,
} from "@/features/transactions/transaction-filters-utils";
import { PeriodFilterBar } from "@/features/transactions/PeriodFilter";
import {
  DEFAULT_PERIOD_FILTER,
  getDateRange,
  type PeriodFilter,
} from "@/features/transactions/period-filter-utils";
import type { TransactionFormInitialValues } from "@/features/transactions/use-transaction-form-state";
import { centsToReais } from "@/features/transactions/transaction-form-utils";
import {
  isTransactionTypeCode,
  type TransactionTypeCode,
} from "@shared/constants/transaction-types";

type TxRow = TrpcOutput["transactions"]["list"][number];

const STORAGE_KEY = "transactions-table-config-v1";
const SAVED_FILTERS_KEY = "transactions-saved-filters-v1";

function TxRecurrenceDialog({
  row,
  onClose,
}: {
  row: TxRow | null;
  onClose: () => void;
}): ReactElement {
  return (
    <CreateRecurrenceDialog
      open={row !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      transactionTypeCode={row !== null ? typeCodeForTx(row) : "EXPENSE"}
      {...(row !== null ? { initialValues: initialValuesForTx(row) } : {})}
      onCreated={onClose}
    />
  );
}

function isColumnVisible(col: Column, hidden: ColumnKey[]): boolean {
  const overridden = hidden.includes(col.key);
  return col.defaultVisible ? !overridden : overridden;
}

function typeCodeForTx(row: TxRow): TransactionTypeCode {
  if (row.transactionTypeCode !== null && isTransactionTypeCode(row.transactionTypeCode)) {
    return row.transactionTypeCode;
  }
  return "EXPENSE";
}

function initialValuesForTx(row: TxRow): TransactionFormInitialValues {
  const out: TransactionFormInitialValues = {
    accrualDate: row.accrualDate,
    dueDate: row.dueDate,
    forecastReais: centsToReais(row.forecastAmount),
  };
  if (row.description !== null) out.description = row.description;
  if (row.reference !== null) out.reference = row.reference;
  if (row.actualDate !== null) out.actualDate = row.actualDate;
  if (row.actualAmount !== null) out.actualReais = centsToReais(row.actualAmount);
  if (row.creditorId !== null) out.creditorId = row.creditorId;
  if (row.categoryId !== null) out.categoryId = row.categoryId;
  if (row.paymentMethodId !== null) out.paymentMethodId = row.paymentMethodId;
  if (row.subtypeId !== null) out.subtypeId = row.subtypeId;
  if (row.cashBoxId !== null) out.cashBoxId = row.cashBoxId;
  if (row.businessUnitId !== null) out.businessUnitId = row.businessUnitId;
  return out;
}

type TableConfig = {
  hidden: ColumnKey[];
  sortKey: ColumnKey | null;
  sortDir: "asc" | "desc";
  valuesHidden: boolean;
  pageSize: PageSize;
  page: number;
};

const DEFAULT_CONFIG: TableConfig = {
  hidden: [],
  sortKey: null,
  sortDir: "desc",
  valuesHidden: true,
  pageSize: 25,
  page: 1,
};

function loadConfig(): TableConfig {
  if (typeof window === "undefined") return DEFAULT_CONFIG;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw) as Partial<TableConfig>;
    const pageSize: PageSize = isPageSize(parsed.pageSize)
      ? parsed.pageSize
      : DEFAULT_CONFIG.pageSize;
    const page = typeof parsed.page === "number" && parsed.page >= 1 ? Math.floor(parsed.page) : 1;
    return {
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden : [],
      sortKey: parsed.sortKey ?? null,
      sortDir: parsed.sortDir === "asc" ? "asc" : "desc",
      valuesHidden: parsed.valuesHidden ?? true,
      pageSize,
      page,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function saveConfig(cfg: TableConfig): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    void 0;
  }
}

function loadSavedFilters(): SavedFilter[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(SAVED_FILTERS_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is SavedFilter =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>).id === "string" &&
        typeof (item as Record<string, unknown>).name === "string" &&
        typeof (item as Record<string, unknown>).filters === "object",
    );
  } catch {
    return [];
  }
}

function saveSavedFilters(filters: SavedFilter[]): void {
  try {
    window.localStorage.setItem(SAVED_FILTERS_KEY, JSON.stringify(filters));
  } catch {
    void 0;
  }
}

export function TransactionsPage(): ReactElement {
  const listQuery = trpc.transactions.list.useQuery();
  const [createOpen, setCreateOpen] = useState<TransactionTypeCode | null>(null);
  const [recurrenceFor, setRecurrenceFor] = useState<TxRow | null>(null);
  const [config, setConfig] = useState<TableConfig>(loadConfig);
  const [appliedFilters, setAppliedFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [savedFilters, setSavedFilters] = useState<SavedFilter[]>(loadSavedFilters);
  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>(DEFAULT_PERIOD_FILTER);
  useEffect(() => {
    saveConfig(config);
  }, [config]);
  useEffect(() => {
    saveSavedFilters(savedFilters);
  }, [savedFilters]);
  const visibleColumns = useMemo(
    () => COLUMNS.filter((col) => isColumnVisible(col, config.hidden)),
    [config.hidden],
  );
  const filteredRows = useMemo(() => {
    const rows = listQuery.data ?? [];
    const { start, end } = getDateRange(periodFilter.granularity, periodFilter.anchor);
    const filtersWithPeriod: Filters = {
      ...appliedFilters,
      periodFrom: start,
      periodTo: end,
    };
    return applyFilters(rows, filtersWithPeriod);
  }, [listQuery.data, appliedFilters, periodFilter]);
  const sortedRows = useMemo(() => {
    if (config.sortKey === null) return filteredRows;
    const col = COLUMNS.find((c) => c.key === config.sortKey);
    if (!col) return filteredRows;
    const dir = config.sortDir === "asc" ? 1 : -1;
    return [...filteredRows].sort((a, b) => {
      const av = col.sortValue(a);
      const bv = col.sortValue(b);
      if (av === null && bv === null) return 0;
      if (av === null) return 1;
      if (bv === null) return -1;
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [filteredRows, config.sortKey, config.sortDir]);

  const totals = useMemo(() => totalsFrom(filteredRows), [filteredRows]);
  const paginated = usePagination(sortedRows, { page: config.page, pageSize: config.pageSize });

  function toggleColumn(key: ColumnKey): void {
    setConfig((prev) => ({
      ...prev,
      hidden: prev.hidden.includes(key)
        ? prev.hidden.filter((k) => k !== key)
        : [...prev.hidden, key],
    }));
  }
  function toggleSort(key: ColumnKey): void {
    setConfig((prev) => {
      if (prev.sortKey !== key) return { ...prev, sortKey: key, sortDir: "asc", page: 1 };
      if (prev.sortDir === "asc") return { ...prev, sortDir: "desc", page: 1 };
      return { ...prev, sortKey: null, sortDir: "desc", page: 1 };
    });
  }
  function resetColumns(): void {
    setConfig((prev) => ({
      ...DEFAULT_CONFIG,
      valuesHidden: prev.valuesHidden,
      pageSize: prev.pageSize,
    }));
  }
  function toggleValuesHidden(): void {
    setConfig((prev) => ({ ...prev, valuesHidden: !prev.valuesHidden }));
  }
  function setPage(page: number): void {
    setConfig((prev) => ({ ...prev, page }));
  }
  function setPageSize(pageSize: PageSize): void {
    setConfig((prev) => ({ ...prev, pageSize, page: 1 }));
  }
  return (
    <AppLayout>
      <div className="flex flex-col">
        <PageHeader
          eyebrow="Livro de lançamentos"
          title="Transações"
          aside={
            <div className="flex items-center gap-2 flex-wrap justify-end">
              {listQuery.data && listQuery.data.length > 0 && (
                <>
                  <TotalsInline
                    income={totals.income}
                    outflow={totals.outflow}
                    balance={totals.balance}
                    hidden={config.valuesHidden}
                    onToggle={toggleValuesHidden}
                  />
                  <span
                    aria-hidden="true"
                    className="hidden md:inline-block h-5 w-px bg-[color:var(--rule)]"
                  />
                </>
              )}
              <FiltrosButton
                rows={listQuery.data ?? []}
                appliedFilters={appliedFilters}
                onApplyFilters={setAppliedFilters}
                savedFilters={savedFilters}
                onSavedFiltersChange={setSavedFilters}
              />
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm">
                    <Settings2 className="mr-1 h-4 w-4" />
                    Colunas ({visibleColumns.length})
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-[60vh] overflow-y-auto">
                  <DropdownMenuLabel>Mostrar colunas</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {COLUMNS.map((c) => (
                    <DropdownMenuCheckboxItem
                      key={c.key}
                      checked={isColumnVisible(c, config.hidden)}
                      onCheckedChange={() => {
                        toggleColumn(c.key);
                      }}
                      onSelect={(e) => {
                        e.preventDefault();
                      }}
                    >
                      {c.label}
                    </DropdownMenuCheckboxItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuCheckboxItem
                    checked={false}
                    onCheckedChange={resetColumns}
                    onSelect={(e) => {
                      e.preventDefault();
                    }}
                  >
                    Restaurar padrão
                  </DropdownMenuCheckboxItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setCreateOpen("EXPENSE");
                }}
                className="text-[color:var(--negative)]"
              >
                <TrendingDown />
                Despesa
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setCreateOpen("REVENUE");
                }}
                className="text-[color:var(--positive)]"
              >
                <TrendingUp />
                Recebimento
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setCreateOpen("TRANSFER_INTERNAL");
                }}
              >
                <ArrowLeftRight />
                Transferência
              </Button>
            </div>
          }
        />

        {listQuery.data && listQuery.data.length > 0 && (
          <PeriodFilterBar filter={periodFilter} onChange={setPeriodFilter} />
        )}

        {listQuery.isLoading && (
          <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)]">
            Carregando…
          </p>
        )}
        {listQuery.error && (
          <p className="text-[length:var(--fs-body-sm)] text-[color:var(--negative)]">
            Erro: {listQuery.error.message}
          </p>
        )}
        {listQuery.data?.length === 0 && (
          <div className="py-16 flex flex-col items-center gap-3 text-center">
            <Eyebrow>Livro vazio</Eyebrow>
            <p className="font-serif text-[length:var(--fs-display)] font-[400] italic leading-[1.1] text-[color:var(--ink-soft)] max-w-md">
              Nenhum lançamento ainda.
            </p>
            <p className="text-[length:var(--fs-body-sm)] text-[color:var(--ink-mute)] max-w-md">
              Importe um extrato bancário em{" "}
              <Link
                href="/imports"
                className="text-[color:var(--accent)] hover:underline underline-offset-4"
              >
                Importações
              </Link>{" "}
              para começar.
            </p>
          </div>
        )}

        {listQuery.data && listQuery.data.length > 0 && (
          <div className="flex flex-col gap-2">
            <TransactionsLedgerTable
              rows={paginated.rows}
              visibleColumns={visibleColumns}
              sortKey={config.sortKey}
              sortDir={config.sortDir}
              onToggleSort={toggleSort}
              onRecurrenceClick={setRecurrenceFor}
            />
            <TablePagination
              page={paginated.page}
              pageSize={paginated.pageSize}
              totalRows={paginated.totalRows}
              startIndex={paginated.startIndex}
              endIndex={paginated.endIndex}
              totalPages={paginated.totalPages}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
            />
          </div>
        )}
      </div>
      {createOpen !== null && (
        <CreateTransactionDialog
          open={true}
          onOpenChange={(o) => {
            if (!o) setCreateOpen(null);
          }}
          transactionTypeCode={createOpen}
        />
      )}
      <TxRecurrenceDialog
        row={recurrenceFor}
        onClose={() => {
          setRecurrenceFor(null);
        }}
      />
    </AppLayout>
  );
}
