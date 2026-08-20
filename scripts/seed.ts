// scripts/seed.ts
//
// Seeds system-owned data: list_of_values rows for every system type
// (DRE_GROUP, TRANSACTION_TYPE, TRANSACTION_STATUS, TRANSACTION_SUBTYPE,
// STATEMENT_IMPORT_FILE_STATUS, STATEMENT_IMPORT_ROW_STATUS, BANK_SLUG,
// BANK_ROUTING, CASH_BOX_TYPE, BUSINESS_UNIT_TYPE, PAYMENT_METHOD, TENANT_VALUES).
//
// Every system seed runs through `seedSystemLov`, which is idempotent:
// deletes rows whose code is outside the owned set, dedups duplicates of
// owned codes (keeping the oldest), and upserts value/sort_order. Wrapped
// in a single transaction for atomicity.
//
// Invoked by `pnpm db:seed`.

import "dotenv/config";
import { fileURLToPath } from "node:url";
import { and, asc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { listOfValues } from "../drizzle/schema";
import { seedSystemImportMatchRules } from "./seed-import-match-rules";

export { IMPORT_MATCH_RULES_SEED, type ImportRuleSeedEntry } from "./seed-import-match-rules";

type SeedTx = Parameters<Parameters<ReturnType<typeof drizzle>["transaction"]>[0]>[0];

// DRE groups: 9 system rows in list_of_values with type='DRE_GROUP'.
// DNO is intentionally excluded per BA M-04 RN-4 / M-12.
export const DRE_GROUPS_SEED = [
  { code: "F", value: "Faturamento", sortOrder: 1 },
  { code: "RV", value: "Receita", sortOrder: 2 },
  { code: "CMV", value: "Custo da Mercadoria Vendida", sortOrder: 3 },
  { code: "CVI", value: "Custos Variáveis", sortOrder: 4 },
  { code: "CF", value: "Custos Fixos", sortOrder: 5 },
  { code: "INV", value: "Investimentos", sortOrder: 6 },
  { code: "RO", value: "Resultados Operacionais", sortOrder: 7 },
  { code: "SI", value: "Sócios", sortOrder: 8 },
  { code: "TC", value: "Transferências", sortOrder: 9 },
] as const;

// TRANSACTION_TYPE: 7 system rows in list_of_values with type='TRANSACTION_TYPE'.
// Labels (and sort_order) live here. Product-fixed behavioral flags
// (affects_dre, requires_creditor, requires_category) live as a TypeScript
// const in shared/constants/transaction-types.ts — they are invariants, not
// values, and consumers (M-01 validation, M-07 DRE filter) import them
// directly. Code set must match TRANSACTION_TYPE_CODES (asserted in tests).
export const TRANSACTION_TYPES_SEED = [
  { code: "EXPENSE", label: "Despesa", sortOrder: 10 },
  { code: "REVENUE", label: "Receita", sortOrder: 20 },
  { code: "TRANSFER_INTERNAL", label: "Transferência interna", sortOrder: 30 },
  { code: "CASH_DRAWER_IN", label: "Suprimento de caixa", sortOrder: 40 },
  { code: "CASH_DRAWER_OUT", label: "Saída de cofre", sortOrder: 50 },
  { code: "CASH_DRAWER_SHORT", label: "Sobra/falta de caixa", sortOrder: 60 },
  { code: "ADJUSTMENT", label: "Ajuste", sortOrder: 70 },
] as const;

// TENANT_VALUES: registry of the per-tenant kinds that live in the
// tenant_values table. Each row's `code` (e.g. CUSTOMER) is the kind
// discriminator; `value` is the user-facing pt-BR label used as the picklist
// label when creating a record. Adding a kind: insert a row here and add a
// router/dialog that writes to tenant_values with that kind.
export const TENANT_VALUES_SEED = [
  { code: "CUSTOMER", value: "Clientes", sortOrder: 10 },
  { code: "SUPPLIER", value: "Fornecedores", sortOrder: 20 },
  { code: "CASH_BOX", value: "Caixas", sortOrder: 30 },
  { code: "BUSINESS_UNIT", value: "Unidades de Negócio", sortOrder: 40 },
] as const;

// PAYMENT_METHOD: system rows tenants extend from. Codes are pt-BR matching
// the domain language (precedent: TRANSACTION_STATUS uses CERTO/ESTIMADO/etc.).
// PIX / TED / DOC are kept as distinct codes (not subsumed under
// TRANSFERENCIA) because in Brazil they have different fees and accounting
// rules; TRANSFERENCIA is the generic fallback when the bank statement
// doesn't disambiguate.
export const PAYMENT_METHOD_SEED = [
  { code: "BOLETO", value: "Boleto", sortOrder: 10 },
  { code: "CHEQUE", value: "Cheque", sortOrder: 20 },
  { code: "CREDIARIO", value: "Crediário", sortOrder: 30 },
  { code: "DEBITO_CONTA", value: "Débito em conta", sortOrder: 40 },
  { code: "CARTAO_CREDITO", value: "Cartão de crédito", sortOrder: 50 },
  { code: "CARTAO_DEBITO", value: "Cartão de débito", sortOrder: 60 },
  { code: "DINHEIRO", value: "Dinheiro", sortOrder: 70 },
  { code: "PIX", value: "PIX", sortOrder: 80 },
  { code: "TED", value: "TED", sortOrder: 90 },
  { code: "DOC", value: "DOC", sortOrder: 100 },
  { code: "TRANSFERENCIA", value: "Transferência", sortOrder: 110 },
] as const;

// BANK_ROUTING: maps OFX <BANKID> COMPE codes to the canonical BANK_SLUG row.
// `code` is the 3-digit zero-padded routing code. `value` mirrors `code`
// because the routing code IS its own identity at this level — the bank name
// belongs to the parent BANK_SLUG row and is reachable via JOIN. `parentSlug`
// is the parent BANK_SLUG row's `code`, resolved to a parent_lov FK at seed
// time. Adding a bank: append a row here AND ensure the parent slug exists
// in LOV_SEED.BANK_SLUG.
export const BANK_ROUTING_SEED = [
  { bankId: "341", parentSlug: "itau" },
  { bankId: "033", parentSlug: "santander" },
  { bankId: "237", parentSlug: "bradesco" },
  { bankId: "001", parentSlug: "bb" },
  { bankId: "260", parentSlug: "nubank" },
  { bankId: "077", parentSlug: "inter" },
] as const;

// IMPORT_MATCH_RULES system seed lives in scripts/seed-import-match-rules.ts.
// Re-exported above so existing imports keep working.

// CATEGORY (restaurant audience): system rows tenants of industry='restaurant'
// see in their dropdown via combined-mode read. Vertical-tagged via the
// `category` column. The list itself is owned by the BA — this constant stays
// empty until the curated set lands; see M-13 follow-up.
export const CATEGORY_RESTAURANT_SEED: ReadonlyArray<{
  code: string;
  value: string;
  dreGroupCode: string;
  sortOrder: number;
}> = [];

export type LovSeedEntry = { code: string; value: string; description?: string };

export const LOV_SEED: Record<string, LovSeedEntry[]> = {
  STATEMENT_IMPORT_FILE_STATUS: [
    { code: "uploaded_pending", value: "Enviando" },
    { code: "parsing", value: "Processando" },
    { code: "parsed", value: "Pronto para revisão" },
    { code: "parse_failed", value: "Falha ao processar" },
    { code: "approved", value: "Aprovado" },
    { code: "rejected", value: "Rejeitado" },
    { code: "upload_timeout", value: "Tempo esgotado" },
  ],
  // Acquirer registry (G-02). `description` carries the deposit-recognition
  // regex applied (case-insensitive) to bank transaction descriptions —
  // RECURRENCE_PATTERN precedent for machine-readable description.
  ACQUIRER: [{ code: "cielo", value: "Cielo", description: "CIELO" }],
  STATEMENT_IMPORT_SOURCE_KIND: [
    { code: "bank", value: "Extrato bancário" },
    { code: "card", value: "Cartão de crédito" },
  ],
  STATEMENT_IMPORT_ROW_STATUS: [
    { code: "parsed_ok", value: "Lido" },
    { code: "parsed_error", value: "Com erro" },
    { code: "edited", value: "Editado" },
    { code: "reviewed_new", value: "Criar novo" },
    { code: "reviewed_matched", value: "Conciliado" },
    { code: "reviewed_skip", value: "Pular" },
    { code: "deleted", value: "Excluído" },
  ],
  // TRANSACTION_SUBTYPE: fiscal/operational tag orthogonal to PAYMENT_METHOD.
  // Captures things that aren't a "how the money moved" or a DRE bucket:
  // bank fees, taxes, yields/interest, reversals. Future additions land here
  // (SUBSCRIPTION, DIVIDEND, PAYROLL, ...) as the engine learns more contexts.
  TRANSACTION_SUBTYPE: [
    { code: "TARIFA", value: "Tarifa bancária" },
    { code: "IOF", value: "IOF" },
    { code: "RENDIMENTO", value: "Rendimento" },
    { code: "JUROS", value: "Juros" },
    { code: "ESTORNO", value: "Estorno" },
  ],
  // INATIVO is intentionally absent — soft-delete (deleted_at IS NOT NULL) is
  // the canonical inactive state on transactions.
  TRANSACTION_STATUS: [
    { code: "CERTO", value: "Realizado" },
    { code: "ESTIMADO", value: "Estimado" },
    { code: "META", value: "Meta" },
    { code: "REVISAR", value: "Revisar" },
    { code: "FANEC", value: "FANEC" },
  ],
  BANK_SLUG: [
    { code: "santander", value: "Santander" },
    { code: "itau", value: "Itaú" },
    { code: "bradesco", value: "Bradesco" },
    { code: "bb", value: "Banco do Brasil" },
    { code: "caixa", value: "Caixa Econômica" },
    { code: "nubank", value: "Nubank" },
    { code: "inter", value: "Inter" },
    { code: "c6", value: "C6 Bank" },
    { code: "sicoob", value: "Sicoob" },
    { code: "sicredi", value: "Sicredi" },
    { code: "safra", value: "Safra" },
  ],
  CASH_BOX_TYPE: [
    { code: "drawer", value: "Gaveta" },
    { code: "bank", value: "Banco" },
    { code: "treasury", value: "Tesouraria" },
  ],
  BUSINESS_UNIT_TYPE: [
    { code: "bar", value: "Bar" },
    { code: "restaurante", value: "Restaurante" },
    { code: "loja", value: "Loja" },
    { code: "holding", value: "Holding" },
    { code: "distribuidora", value: "Distribuidora" },
    { code: "outro", value: "Outro" },
  ],
  // RECURRENCE_PATTERN: cadence presets for the "Criar Recorrência" feature.
  // System-only (no tenant overrides, ever). The `description` column carries
  // the iCalendar RRULE string the engine parses (api/services/recurrence-generate.ts).
  // Adding a new preset is data-only — insert a row, no code deploy.
  RECURRENCE_PATTERN: [
    { code: "weekdays", value: "Seg. a Sex.", description: "FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR" },
    { code: "daily", value: "Diária", description: "FREQ=DAILY;INTERVAL=1" },
    { code: "weekly", value: "Semanal", description: "FREQ=WEEKLY;INTERVAL=1" },
    { code: "biweekly", value: "Quinzenal", description: "FREQ=WEEKLY;INTERVAL=2" },
    { code: "monthly", value: "Mensal", description: "FREQ=MONTHLY;INTERVAL=1" },
    { code: "bimonthly", value: "Bimestral", description: "FREQ=MONTHLY;INTERVAL=2" },
    { code: "quarterly", value: "Trimestral", description: "FREQ=MONTHLY;INTERVAL=3" },
    { code: "semiannual", value: "Semestral", description: "FREQ=MONTHLY;INTERVAL=6" },
    { code: "yearly", value: "Anual", description: "FREQ=YEARLY;INTERVAL=1" },
  ],
  // DESCRIPTION_NOISE: bank-statement boilerplate phrases stripped from a row's
  // description before seeding the quick-create dialog name field on the
  // imports review screen. Prefix-only match, accent-insensitive.
  DESCRIPTION_NOISE: [
    { code: "pix_enviado", value: "PIX ENVIADO" },
    { code: "pix_recebido", value: "PIX RECEBIDO" },
    { code: "pagamento_boleto_outros_bancos", value: "PAGAMENTO DE BOLETO OUTROS BANCOS" },
    { code: "pagamento_boleto", value: "PAGAMENTO DE BOLETO" },
    { code: "ted_enviada", value: "TED ENVIADA" },
    { code: "ted_recebida", value: "TED RECEBIDA" },
    { code: "doc_enviado", value: "DOC ENVIADO" },
    { code: "doc_recebido", value: "DOC RECEBIDO" },
    { code: "transferencia_enviada", value: "TRANSFERÊNCIA ENVIADA" },
    { code: "transferencia_recebida", value: "TRANSFERÊNCIA RECEBIDA" },
    { code: "compra_no_debito", value: "COMPRA NO DÉBITO" },
    { code: "compra_no_credito", value: "COMPRA NO CRÉDITO" },
    { code: "tarifa", value: "TARIFA" },
  ],
};

/**
 * Idempotent system-LOV seed. Owns rows scoped to (tenantId IS NULL, type,
 * category) — anything in that scope outside the `rows` set is deleted, the
 * rest is upserted by code. `category` (default null) targets a specific
 * audience (e.g. 'restaurant'); restaurant CATEGORY seed runs independently
 * from any future bar CATEGORY seed, neither touches the other.
 *
 * Per-row `parentLov` is set as-is; pass null for top-level types.
 */
async function seedSystemLov(
  tx: SeedTx,
  type: string,
  rows: ReadonlyArray<{
    code: string;
    value: string;
    description?: string | null;
    sortOrder?: number;
    parentLov?: string | null;
  }>,
  options?: { category?: string | null },
): Promise<void> {
  const owned = rows.map((r) => r.code);
  const category = options?.category ?? null;

  const categoryClause =
    category === null ? isNull(listOfValues.category) : eq(listOfValues.category, category);

  await tx
    .delete(listOfValues)
    .where(
      and(
        isNull(listOfValues.tenantId),
        eq(listOfValues.type, type),
        categoryClause,
        notInArray(listOfValues.code, owned),
      ),
    );

  for (const row of rows) {
    const existing = await tx
      .select({ id: listOfValues.id })
      .from(listOfValues)
      .where(
        and(
          isNull(listOfValues.tenantId),
          eq(listOfValues.type, type),
          categoryClause,
          eq(listOfValues.code, row.code),
          isNull(listOfValues.deletedAt),
        ),
      )
      .orderBy(asc(listOfValues.createdAt));

    const [first, ...rest] = existing;
    if (first === undefined) {
      await tx.insert(listOfValues).values({
        type,
        code: row.code,
        value: row.value,
        description: row.description ?? null,
        category,
        parentLov: row.parentLov ?? null,
        tenantId: null,
        language: "pt-BR",
        sortOrder: row.sortOrder ?? 0,
      });
      continue;
    }

    const extraIds = rest.map((r) => r.id);
    if (extraIds.length > 0) {
      await tx.delete(listOfValues).where(inArray(listOfValues.id, extraIds));
    }
    await tx
      .update(listOfValues)
      .set({
        value: row.value,
        description: row.description ?? null,
        sortOrder: row.sortOrder ?? 0,
        parentLov: row.parentLov ?? null,
      })
      .where(eq(listOfValues.id, first.id));
  }

  const label = category === null ? type : `${type} [${category}]`;
  console.warn(`[seed] ✓ ${label} (${rows.length} rows)`);
}

async function main(): Promise<void> {
  const connectionString =
    process.env["DATABASE_URL"] ??
    `postgresql://${process.env["DB_USER"]}:${process.env["DB_PASSWORD"]}@${process.env["DB_HOST"]}/${process.env["DB_NAME"]}`;

  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 1,
  });

  try {
    const db = drizzle(pool);
    await db.transaction(async (tx) => {
      await seedSystemLov(tx, "DRE_GROUP", DRE_GROUPS_SEED);
      await seedSystemLov(
        tx,
        "TRANSACTION_TYPE",
        TRANSACTION_TYPES_SEED.map((t) => ({
          code: t.code,
          value: t.label,
          sortOrder: t.sortOrder,
        })),
      );
      await seedSystemLov(tx, "PAYMENT_METHOD", PAYMENT_METHOD_SEED);
      await seedSystemLov(tx, "TENANT_VALUES", TENANT_VALUES_SEED);
      for (const [type, entries] of Object.entries(LOV_SEED)) {
        await seedSystemLov(
          tx,
          type,
          entries.map((r, i) => ({ ...r, sortOrder: i })),
        );
      }

      const bankSlugs = await tx
        .select({ id: listOfValues.id, code: listOfValues.code })
        .from(listOfValues)
        .where(
          and(
            eq(listOfValues.type, "BANK_SLUG"),
            isNull(listOfValues.tenantId),
            isNull(listOfValues.deletedAt),
          ),
        );
      const bankSlugByCode = new Map(bankSlugs.map((s) => [s.code, s.id]));

      const routingRows = BANK_ROUTING_SEED.map((r, i) => {
        const parentLov = bankSlugByCode.get(r.parentSlug);
        if (parentLov === undefined) {
          throw new Error(
            `[seed] BANK_ROUTING '${r.bankId}' references unknown BANK_SLUG '${r.parentSlug}'`,
          );
        }
        return { code: r.bankId, value: r.bankId, sortOrder: i, parentLov };
      });
      await seedSystemLov(tx, "BANK_ROUTING", routingRows);

      if (CATEGORY_RESTAURANT_SEED.length > 0) {
        const dreGroups = await tx
          .select({ id: listOfValues.id, code: listOfValues.code })
          .from(listOfValues)
          .where(
            and(
              eq(listOfValues.type, "DRE_GROUP"),
              isNull(listOfValues.tenantId),
              isNull(listOfValues.deletedAt),
            ),
          );
        const dreByCode = new Map(dreGroups.map((g) => [g.code, g.id]));

        const rows = CATEGORY_RESTAURANT_SEED.map((r) => {
          const parentLov = dreByCode.get(r.dreGroupCode);
          if (parentLov === undefined) {
            throw new Error(
              `[seed] CATEGORY '${r.code}' references unknown DRE group '${r.dreGroupCode}'`,
            );
          }
          return {
            code: r.code,
            value: r.value,
            sortOrder: r.sortOrder,
            parentLov,
          };
        });

        await seedSystemLov(tx, "CATEGORY", rows, { category: "restaurant" });
      }

      await seedSystemImportMatchRules(tx);
    });

    console.warn("[seed] ✓ all seeds applied");
  } finally {
    await pool.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error("[seed] ✗ failed:", err);
    process.exit(1);
  });
}
