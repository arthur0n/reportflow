# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ReportFlow is a greenfield project. This repo currently contains only the foundation — strict tooling, auth, infra, and conventions — so feature work can start from a single documented pattern: tRPC procedure → scoped Drizzle query → Clerk-authenticated React hook → typed UI.

**Language convention:** Everything in code is English — file names, variable/function/type names, schema fields, route paths and dynamic slugs, code comments, JSON keys. The single exception is **display text rendered to users as content**: button labels, page titles, toast messages, form labels, descriptions, validation/error messages shown in the UI. That display text is Brazilian Portuguese (pt-BR) for now and will move to a localization layer later. URLs and route slugs are code, not text — always English, never pt-BR (`/parameters/payment-methods`, never `/parametros/formas-de-pagamento`). Use kebab-case for multi-word URL segments.

## Commands

```bash
pnpm dev          # Start Express dev server (tRPC)
pnpm dev:app      # Start Vite dev server (frontend)
pnpm build        # Vite production build (dist/app/)
pnpm check        # TypeScript type checking (tsc --noEmit)
pnpm lint         # ESLint (strict + type-aware rules)
pnpm lint:fix     # ESLint with --fix
pnpm format       # Prettier --write
pnpm test         # Vitest run
pnpm test:watch   # Vitest watch mode
pnpm validate     # check + lint + test (used by PR CI)
pnpm db:generate  # Generate migration SQL from drizzle/schema.ts (review before applying)
pnpm db:migrate   # Apply pending migrations to the DB
```

## Stack

- **Frontend:** React 19 + Wouter + TanStack Query + tRPC 11 + shadcn/ui + Tailwind CSS 4 + Clerk
- **Backend:** AWS (sa-east-1) Lambda + API Gateway (HTTP API) + tRPC 11 + Drizzle ORM + PostgreSQL (shared `mrhewbuc-rds` instance)
- **Auth:** Clerk — offline JWT verification via PEM public key (`CLERK_JWT_KEY`)
- **Build:** Vite 7 (client) + SAM/esbuild (Lambda)
- **Package manager:** pnpm 10
- **Node:** 22 (local + CI), 24 (Lambda runtime)

## Policies

### NEVER do these

- **NEVER skip the scope helper** — all tenant-scoped queries MUST use `createScopedDb()` from `api/db/scope.ts`. Bypassing it breaks multi-tenant isolation and soft-delete filtering.
- **NEVER add a new table to `drizzle/schema.ts` without adding a `TABLE_SCOPE` entry** in `api/db/scope.ts`. The table-to-scope map is the enforcement lever.
- **NEVER use `publicProcedure`** unless the endpoint is genuinely public (health checks, truly public data). Default to `protectedProcedure`.
- **NEVER apply SQL directly to the database** (e.g. `psql -f`, `psql -c "ALTER TABLE..."`) — always go through `db:generate` → review the SQL → `db:migrate`. If `db:generate` asks interactive rename/create prompts, stop and ask the user.
- **NEVER hardcode dropdown/select options in the UI.** System catalogs and the registry of tenant_values kinds (`type='TENANT_VALUES'`) come from `list_of_values` via the `useLov({ type })` hook (`app/src/hooks/use-lov.ts`). Tenant-scoped record pickers (e.g. "which supplier?", "which cash box?") come from `tenant_values` via their domain router list (until the generic tenant_values modal lands).
- **NEVER add new shadcn/ui components manually** — use `npx shadcn@latest add <component>` to keep them consistent.
- **NEVER use `useEffect` for derived state** — calculate during render.
- **NEVER use `useEffect` to respond to user events** — use event handlers.
- **NEVER commit `.env`** — it's in `.gitignore`; double-check before `git add -A`.
- **NEVER deploy manually** — production deploys go through GitHub Actions (`deploy-api.yml`, `deploy-app.yml`) exclusively.
- **NEVER add a `motivo` / `reason` field to soft-delete or audit rows.** `audit_logs` records action + actor + timestamp without a required reason; soft-deletes set `deleted_at` / `deleted_by` and stop there.
- **NEVER propose denormalization "for read performance" without measured need.** ReportFlow is the relational rebuild of an Excel tool; default to JOIN. If a real hot path emerges, the right pattern is a materialized rollup table with explicit refresh — not a denormalized column on a row table.
- **NEVER query `list_of_values` without filtering by both `tenant_id` (or `tenant_id IS NULL`) AND `type`.** Type-less LOV reads are a foot-gun. Always go through `lovConditions({ type, mode })` on the scope helper.
- **NEVER add a `metadata jsonb` column to `list_of_values`** (or any other catch-all blob column to it). LOV has a fixed shape; per-type extras go in a typed sidecar 1:1 table justified by a tech plan. The same caution applies to other tables — typed columns first, sidecar second, blob almost never.
- **NEVER add an `is_active` (or `enabled`, or `status='active'`) boolean to a soft-deletable table.** `deleted_at IS NULL` is the canonical active state. Two encodings of the same fact diverge — one mutation forgets to update both, and "active" rows show up in deactivated dropdowns.

### ALWAYS do these

- **ALWAYS use snake_case for DB column names** in schema definitions and raw SQL (Drizzle maps them to camelCase in TS).
- **ALWAYS use camelCase for TS variables**.
- **ALWAYS invalidate queries after mutations** — every mutation hook must call `utils.<router>.invalidate()` on success.
- **ALWAYS use SuperJSON transformer** — Dates and Decimals are serialized via SuperJSON. Never manually serialize/parse.
- **ALWAYS verify Clerk JWT offline** — use `verifyClerkJWT` from `api/lib/clerk.ts` (backed by `CLERK_JWT_KEY`), never network-based `/me` checks per request.
- **ALWAYS run `pnpm validate` before opening a PR**.
- **ALWAYS file a GitHub issue for every follow-up listed in a tech plan's "Out of scope / follow-ups" section** before the plan moves from Draft to Approved. The plan links each follow-up to its issue.
- **ALWAYS include the four system fields on every table without exception:** `created_at`, `created_by`, `last_upd_at`, `last_upd_by`. Soft-deleted tables additionally carry `deleted_at`, `deleted_by`. System-seeded tables leave actor columns NULL but the columns still exist. Existing tables not yet compliant are tracked for backfill — do not regress them. Use the `withSystemFields(ctx, kind)` helper from `api/db/scope.ts`.
- **ALWAYS write audit log rows from mutating procedures** that change tenant-visible data, using `writeAuditEntry` from `api/services/audit.ts`. One row per changed field on `update`; one row per action on `create` / `delete` / `restore` / `reclassify`.
- **ALWAYS use `UPPER_SNAKE_CASE` for `list_of_values.type` discriminator values** (e.g., `DRE_GROUP`, `CATEGORY`, `SUPPLIER`, `CUSTOMER`, `BANK_SLUG`).
- **ALWAYS dedup LOV rows via `(tenant_id, type, code)`.** For tenant-scoped rows, `code` is the slugified `value`, written by the LOV-CRUD core (`api/services/lov-crud.ts`) using `slugify` from `shared/validation/slugify.ts`. System-seeded rows (`tenant_id IS NULL`) use hand-curated codes assigned in `scripts/seed.ts` (e.g. `F`, `CMV`, `nubank`); they do NOT go through the slugifier. Never write a separate `*_normalized` column or hand-roll a normalization helper for an LOV-shaped table; never write `list_of_values.code` from an application code path other than the LOV-CRUD core or the seed script.
- **ALWAYS cache LOV reads.** TanStack Query handles client cache (long `staleTime` for LOV queries); the API uses an in-memory per-Lambda cache for system LOV reads, busted on mutation. Do not bypass this and hit DB per render.
- **ALWAYS require a business rule for every column.** When the BA names a field, the plan must cite at least one RN/CA or downstream consumer that reads it. Fields with no reader are Excel cargo — drop at design time and escalate to the PO via the plan's Open questions. The default action on an unreferenced field is to remove it, not to preserve it.

### Import Rules

| Context             | Style                   | Example                                           |
| ------------------- | ----------------------- | ------------------------------------------------- |
| **Frontend (app/)** | `@/` aliases            | `import { Button } from '@/components/ui/button'` |
| **API (api/)**      | Relative imports only   | `import { db } from '../db/client'`               |
| **Shared (both)**   | `@shared/*` or relative | `import { schema } from '@shared/validation'`     |

**Why relative in API:** SAM's esbuild does not resolve `tsconfig.json` path aliases.

### Database Migration Rules

```bash
pnpm db:generate   # 1. Generate SQL migration files from drizzle/schema.ts
# 2. REVIEW generated SQL in drizzle/*.sql
pnpm db:migrate    # 3. Apply the reviewed migration
```

When Drizzle prompts for renames, **always select "rename column"** (preserves data) over "create column" (deletes data). For non-trivial type changes (boolean → varchar, etc.), write SQL manually via `psql`, then run `db:generate` to update the snapshot.

## Architecture Rules

### Multi-tenancy (CRITICAL)

We own the tenancy model. The auth provider (Clerk today, swappable via `api/lib/auth-provider/`) is just an identity adapter.

- `tenants` rows are orgs. `tenants.external_id` holds the auth provider's org id.
- `users` rows are people. `users.external_id` holds the auth provider's user id.
- `users.tenant_id` (FK → `tenants.id`) joins each user to one tenant. Many users can share the same tenant.
- `ctx.tenantId` comes from `users.tenant_id`; `ctx.userId` is `users.id`. They are distinct UUIDs — do not confuse them.
- All domain rows carry `tenant_id` FK → `tenants.id`. Ownership is by our UUID, not by the auth provider's id.
- One user in multiple orgs is out of scope at MVP. When it lands, switch from a single `users.tenant_id` FK to a `memberships` join table and read the active org from the JWT in `api/trpc/context.ts`.

Every query that touches a tenant-scoped table MUST go through `createScopedDb()`:

```typescript
// CORRECT — scoped
const scope = createScopedDb({ tenantId: ctx.tenantId });
const rows = await db.select().from(properties).where(scope.conditions(properties));

// WRONG — bypasses tenant isolation
const rows = await db.select().from(properties);
```

### tRPC Procedures

Three tiers in `api/trpc/procedures.ts`:

- `publicProcedure` — no auth (health checks, truly public data)
- `protectedProcedure` — requires Clerk JWT, injects `ctx.tenantId` + `ctx.userId`
- `adminProcedure` — protectedProcedure + `users.role === "admin"`

### Webhook Routes (in `api/handler.ts`)

- `POST /webhooks/clerk` — user lifecycle (created, updated, deleted). This is the ONLY place where `users` rows are written. Every other code path assumes the row already exists.

Svix is used for webhook signature verification via `CLERK_WEBHOOK_SECRET` (SSM in prod, `.env` locally).

## Environment Variables

**Required (API — from SSM in prod, `.env` in dev):**

- `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` (or `DATABASE_URL`)
- `CLERK_JWT_KEY` — PEM public key from Clerk Dashboard → API Keys
- `CLERK_WEBHOOK_SECRET` — Signing secret from Clerk Dashboard → Webhooks
- `CLERK_SECRET_KEY` — Backend API key from Clerk Dashboard. Used by the onboarding service to create orgs and password-setup tickets.
- `APP_URL` — Public URL of the Vite app (used by the staff-created onboarding flow to build password-setup ticket URLs).

**Required (Frontend — bundled at build time):**

- `VITE_CLERK_PUBLISHABLE_KEY`
- `VITE_API_URL` — dev: `http://localhost:3001/api/trpc`; prod: the API Gateway URL from `sam deploy` outputs

## Documentation

Detailed docs in `docs/design/`:

| Topic                | File                        |
| -------------------- | --------------------------- |
| Architecture         | `architecture.md`           |
| Conventions          | `conventions.md`            |
| Authentication       | `authentication.md`         |
| Database             | `database.md`               |
| Tech plan convention | `tech-plan-convention.md`   |
| Module tech plans    | `M-XX-<topic>-tech-plan.md` |
