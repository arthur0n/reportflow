# Database Migration

Apply reviewed Drizzle migrations to RDS.

## Safe workflow

```bash
# 1. Edit drizzle/schema.ts
# 2. Generate the SQL diff
pnpm db:generate

# 3. REVIEW the generated file in drizzle/<NNNN>_*.sql
#    Look for: unexpected DROPs, renames, type changes, missing indexes.
#    If the diff looks wrong, fix the schema and regenerate.

# 4. Apply to RDS
pnpm db:migrate
```

## Hard rules

- **NEVER use `db:push`** — it applies schema changes directly without producing a reviewable SQL file. The script does not exist in `package.json` by design.
- **NEVER apply SQL manually** (`psql -c "ALTER TABLE..."`) — always go through `db:generate` → review → `db:migrate`. Exceptions are type-conversion migrations Drizzle can't express, which require writing the SQL by hand in `psql`, applying to dev, then running `db:generate` to sync the snapshot.
- When Drizzle prompts "rename column X → Y?" or "create column Y?", **always pick rename** (preserves data) — creating drops the old column.
- `drizzle/*.sql` and `drizzle/meta/*.json` must be committed. `drizzle/meta/` is NOT gitignored — Drizzle needs the snapshot to diff correctly on the next `db:generate`.

## Under the hood

`pnpm db:migrate` runs `tsx scripts/migrate.ts` which uses drizzle-orm's programmatic `migrate()` function (more reliable than `drizzle-kit migrate`, which has a history of dying silently).
