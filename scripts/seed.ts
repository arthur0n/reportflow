// scripts/seed.ts
//
// Seeds system-owned data: list_of_values rows for baseline system types
// (TENANT_VALUES, BANK_SLUG, CASH_BOX_TYPE, BUSINESS_UNIT_TYPE). Domain
// seeds (DRE groups, transaction types, payment methods, imports, ...) were
// removed with the scaffold's finance domain — reintroduce them alongside
// the domain rebuild.
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

type SeedTx = Parameters<Parameters<ReturnType<typeof drizzle>["transaction"]>[0]>[0];

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

export type LovSeedEntry = { code: string; value: string; description?: string };

export const LOV_SEED: Record<string, LovSeedEntry[]> = {
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
      await seedSystemLov(tx, "TENANT_VALUES", TENANT_VALUES_SEED);
      for (const [type, entries] of Object.entries(LOV_SEED)) {
        await seedSystemLov(
          tx,
          type,
          entries.map((r, i) => ({ ...r, sortOrder: i })),
        );
      }
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
