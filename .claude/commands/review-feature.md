# Review Feature

Review a feature against reportflow conventions. Read-only — produce a report, do not modify files.

## Feature to review

$ARGUMENTS

---

## Instructions

**Enter plan mode first.** This is a research task, not an implementation.

### Step 1: Read the conventions

Load these into context:

- `docs/project_conventions.md` — repo-wide rules
- `CLAUDE.md` — project-level NEVER/ALWAYS
- `docs/design/conventions.md` — naming + import rules
- `docs/design/authentication.md`
- `docs/design/database.md`

### Step 2: Locate the feature

- Frontend: `app/src/features/{feature}/`
- Backend router: `api/trpc/routers/{feature}.router.ts`
- Schema(s): `drizzle/schema.ts` (grep for table names)
- Zod: `shared/validation/{feature}*.ts`

### Step 3: Run the 7 checks

For each check, answer a binary question: **"Does this match the convention or not?"** No "minor", no "critical" — either compliant or not.

#### Check 1 — file structure

Compare against `docs/project_conventions.md §9 "Feature modules"`:

```
features/{name}/
├── {Name}Page.tsx
├── {Name}DetailPage.tsx   (optional)
├── components/
│   ├── {Name}Table.tsx
│   ├── {Name}Card.tsx
│   ├── {Name}Form.tsx
│   ├── {Name}Dialogs.tsx
│   └── {Name}Status.tsx
└── hooks/
    └── use{Name}Mutations.ts
```

#### Check 2 — pattern compliance

- List page uses `useListPage` hook (no manual `useState` for filter/page/search)
- Mutation hook centralized in `use{Name}Mutations.ts`
- Dialog state owned by the parent page
- Dropdowns use `useLov()` — no hardcoded options
- Form Zod schema imported from `@shared/validation/`, never defined locally
- Empty-state component used (two variants: no-data vs. no-results)

#### Check 3 — shared utilities usage

Verify these are imported, not redefined:

| Expected import                    | From                                  |
| ---------------------------------- | ------------------------------------- |
| `useListPage()`                    | `@/shared/hooks/useListPage.ts`       |
| `useLov()`                         | `@/shared/hooks/useLov.ts`            |
| `useDebouncedValue()`              | `@/shared/hooks/useDebouncedValue.ts` |
| `formatCurrency()`, `formatDate()` | `@/shared/lib/format.ts`              |
| `PAGE_SIZE_OPTIONS`                | `@/shared/constants/pagination.ts`    |

Any local redefinition of the above = violation.

#### Check 4 — code quality limits

From `docs/project_conventions.md §5`:

| Metric            | `.ts` limit | `.tsx` limit |
| ----------------- | ----------- | ------------ |
| File lines        | 500         | 500          |
| Function lines    | 100         | 250          |
| Complexity        | 15          | 25           |
| Max params        | 8           | 8            |
| Max nesting depth | 6           | 6            |

If ESLint is passing under `--max-warnings 0`, checks 4 is implicit — but verify by running `pnpm lint` before writing the report.

#### Check 5 — backend router

From `docs/project_conventions.md §7 "Procedure tiers"`:

- Uses `protectedProcedure` (or `adminProcedure`) — `publicProcedure` is a deliberate exception
- Imports Zod schemas from `@shared/validation/`
- Standard procedure names: `list`, `getById`, `create`, `update`, `delete` (plus domain-specific)
- Every query uses `createScopedDb({ tenantId: ctx.tenantId }).conditions(table)`
- New tables have a matching entry in `api/db/scope.ts → TABLE_SCOPE`

#### Check 6 — schema & migrations

- New tables in `drizzle/schema.ts` with the `tenant_id uuid`, `created_at`, `updated_at` columns where appropriate
- Soft-delete tables have `deleted_at timestamp with time zone` + `softDelete: true` in `TABLE_SCOPE`
- Migration SQL in `drizzle/NNNN_*.sql` is committed and looks clean (no DROPs, no data loss)
- `drizzle/meta/` updated (snapshot + journal)

#### Check 7 — strictness + rules

Run mentally (or actually):

- `pnpm check` — green?
- `pnpm lint` — 0 errors, 0 warnings?
- `pnpm test` — passing?

If any of these fail, it blocks everything else in the report.

### Step 4: Write the report

**DO NOT modify files.** Output to the conversation in this format:

---

## Review Report: {Feature}

**Feature path:** `app/src/features/{name}/`
**Router path:** `api/trpc/routers/{name}.router.ts`

### Convention violations

| File:line | Convention | What's wrong |
| --------- | ---------- | ------------ |
| `...`     | `...`      | `...`        |

(Write "None found." if clean.)

### Strictness failures

| Command      | Result                 |
| ------------ | ---------------------- |
| `pnpm check` | ✓ / ✗ (paste errors)   |
| `pnpm lint`  | ✓ / ✗ (paste errors)   |
| `pnpm test`  | ✓ / ✗ (paste failures) |

### Proposals

Patterns that could become project-wide conventions (not violations — improvements).

| Proposal | Rationale |
| -------- | --------- |

---

## Rules

1. **Binary answers.** Either the feature matches the convention or it doesn't. No "minor" / "important" adjectives.
2. **File path + what's wrong.** Don't write prose; point at lines.
3. **Empty sections are OK.** Don't invent violations to fill the report.
4. **Read-only.** No edits. Findings only.
