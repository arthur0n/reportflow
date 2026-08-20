// scripts/seed.ts
//
// Seeds system-owned data: list_of_values rows for baseline system types
// (TENANT_VALUES, BANK_SLUG, CASH_BOX_TYPE, BUSINESS_UNIT_TYPE). Domain
// seeds were removed with the scaffold's finance domain — reintroduce them
// alongside the domain rebuild.
//
// Every system seed runs through `seedSystemLov`, which is idempotent:
// deletes rows whose code is outside the owned set, dedups duplicates of
// owned codes (keeping the oldest), and upserts value/sort_order. Wrapped
// in a single transaction for atomicity.
//
// There are no tenants/memberships rows to seed — a tenant is a Clerk org
// (project_conventions §6) and `users` rows are provisioned by hand (§7).
// Anything tenant-scoped therefore needs the org id passed in explicitly:
//
//   pnpm db:seed                       # system LOV only
//   pnpm db:seed --tenant org_2abc...  # + tenant_values for that org
//   SEED_TENANT_ID=org_2abc... pnpm db:seed
//
// Invoked by `pnpm db:seed`.

import "dotenv/config";
import { fileURLToPath } from "node:url";
import { and, asc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { listOfValues, tenantValues } from "../drizzle/schema";
import { TENANT_VALUE_KINDS, type TenantValueKind } from "../shared/constants/tenant-value-kinds";

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

// Per-org baseline rows for tenant_values, keyed by `kind`. Empty today: the
// report domain has no universal starter records, and seeding a customer's
// own data is the customer's job. Add entries here (not ad-hoc INSERTs) when
// a kind gains a genuine baseline, and `--tenant <org_id>` will apply it.
export const TENANT_VALUES_ROW_SEED: Partial<
  Record<TenantValueKind, ReadonlyArray<{ code: string; value: string; sortOrder?: number }>>
> = {};

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

/**
 * Idempotent per-org tenant_values seed. Insert-if-absent by
 * (tenant_id, kind, code) — never deletes, because rows in this table after
 * the first run belong to the customer, not to the seed.
 */
async function seedTenantValues(tx: SeedTx, tenantId: string): Promise<void> {
  let total = 0;
  for (const kind of TENANT_VALUE_KINDS) {
    const rows = TENANT_VALUES_ROW_SEED[kind] ?? [];
    for (const row of rows) {
      const existing = await tx
        .select({ id: tenantValues.id })
        .from(tenantValues)
        .where(
          and(
            eq(tenantValues.tenantId, tenantId),
            eq(tenantValues.kind, kind),
            eq(tenantValues.code, row.code),
          ),
        )
        .limit(1);
      if (existing.length > 0) continue;
      await tx.insert(tenantValues).values({
        tenantId,
        kind,
        code: row.code,
        value: row.value,
        language: "pt-BR",
        sortOrder: row.sortOrder ?? 0,
      });
      total += 1;
    }
  }
  console.warn(`[seed] ✓ tenant_values for ${tenantId} (${total} new rows)`);
}

/** `--tenant <org_id>` beats SEED_TENANT_ID; neither means "system LOV only". */
function resolveTenantId(argv: readonly string[]): string | null {
  const flagIndex = argv.indexOf("--tenant");
  const fromFlag = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
  const candidate = fromFlag ?? process.env["SEED_TENANT_ID"];
  return candidate !== undefined && candidate.length > 0 ? candidate : null;
}

async function main(): Promise<void> {
  const tenantId = resolveTenantId(process.argv.slice(2));
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
      if (tenantId !== null) {
        await seedTenantValues(tx, tenantId);
      } else {
        console.warn("[seed] – tenant_values skipped (no --tenant / SEED_TENANT_ID)");
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
