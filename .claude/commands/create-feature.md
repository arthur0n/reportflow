# Create Feature

Implement a new feature following the reportflow conventions.

## Request

$ARGUMENTS

---

## Instructions

**Enter plan mode first.** Use `EnterPlanMode` before touching any file.

### Step 1: Read the conventions

Read these, in order:

- `docs/project_conventions.md` (repo-wide) — the non-negotiable rules
- `CLAUDE.md` (project-level) — reportflow-specific NEVER/ALWAYS lists
- `docs/design/conventions.md` — naming, imports, code quality
- `docs/design/authentication.md` — how `ctx.tenantId` + `ctx.userId` get injected
- `docs/design/database.md` — scope helper contract, migration workflow

If any of these is unclear, ask — don't guess.

### Step 2: Search for reusable code

Before writing anything, grep `app/src/shared/` and `shared/validation/`:

- `app/src/shared/lib/format.ts` — formatting (BRL, dates)
- `app/src/shared/hooks/` — cross-feature hooks (useListPage, useLov, etc., as they land)
- `shared/validation/` — Zod schemas (barrel export)

**Rule:** if it exists, USE IT. Don't recreate. If you find yourself wanting to copy-paste a utility, extract it first.

### Step 3: Plan the feature

Write a plan that covers:

1. **Schema changes.** New table(s)? Add to `drizzle/schema.ts`. **Must include** a matching entry in `api/db/scope.ts` → `TABLE_SCOPE` — no exceptions.
2. **Migration.** `pnpm db:generate` produces the SQL; paste it into the plan for review.
3. **Zod schemas.** One file per feature under `shared/validation/` (e.g. `shared/validation/{feature}-schemas.ts`), re-exported from `shared/validation/index.ts`. These back both the tRPC router's `.input(...)` and the react-hook-form `zodResolver(...)`.
4. **tRPC router.** New file at `api/trpc/routers/{feature}.router.ts`. Default to `protectedProcedure`. Every DB read/write through `createScopedDb({ tenantId: ctx.tenantId })`.
5. **Feature module layout.** Follow the structure in `docs/project_conventions.md §9 "Feature modules"`:
   ```
   app/src/features/{name}/
   ├── {Name}Page.tsx           # list view
   ├── components/
   │   ├── {Name}Table.tsx      # desktop
   │   ├── {Name}Card.tsx       # mobile
   │   ├── {Name}Form.tsx       # create/edit
   │   ├── {Name}Dialogs.tsx    # dialog wrappers
   │   └── {Name}Status.tsx     # status badge
   └── hooks/
       └── use{Name}Mutations.ts
   ```
6. **Routing.** Add Wouter routes to `app/src/App.tsx` using `React.lazy` + `<Suspense>`. NEVER inline an arrow in `component={() => ...}` — remounts on every render.

### Step 4: Implement

Exit plan mode with approval, then:

1. Schema + migration first (review the generated SQL before applying).
2. Zod schemas next (backend + frontend both import from the same file).
3. tRPC router with `protectedProcedure` and scoped queries.
4. Frontend pages and components in order of dependency.
5. Every mutation hook must call `utils.<router>.invalidate()` on success.

### Step 5: Validate before committing

```bash
pnpm validate
```

Must be green. The pre-commit hook runs `lint-staged` and the pre-push hook runs `pnpm validate`; don't wait for them — run validate yourself after each logical step so errors don't pile up.

---

## Hard rules (from `docs/project_conventions.md`)

- **NEVER** skip the scope helper. Every tenant-scoped query MUST use `createScopedDb`.
- **NEVER** add a table without a `TABLE_SCOPE` entry in the same commit.
- **NEVER** use `publicProcedure` unless this is a genuinely public endpoint (health check, etc.).
- **NEVER** hardcode dropdown options — use `useLov()` (add it under `app/src/shared/hooks/` if it doesn't exist yet, sourcing from `list_of_values`).
- **NEVER** define shared utilities locally. Put them in `app/src/shared/` first.
- **NEVER** use `useEffect` for derived state. Compute during render.
- **NEVER** define Zod schemas in feature files — always in `shared/validation/`.
- **ALWAYS** use snake_case for DB columns, camelCase for TS, PascalCase for components, kebab-case for utility/router files.
- **ALWAYS** match user-facing text in pt-BR; keep code identifiers in English.
