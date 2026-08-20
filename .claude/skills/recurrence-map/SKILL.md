---
name: recurrence-map
description: |
  Use when the user's request touches the recurrence utility feature in this repo.
  TRIGGER on any of: recurrence / recorrência / recurring transaction; the
  RECURRENCE_PATTERN LOV; iCalendar RRULE / rrule library; the
  recurrences.createWithSource mutation; transaction_recurrences table;
  transactions.recurrence_id; CreateRecurrenceDialog; CreateTransactionDialog
  with the Repetir tab; useTransactionFormState / useRecurrenceConfigState
  hooks; TransactionFormFields / RecurrenceModeFields components;
  occurrence generation / horizon / cadence; ESTIMADO sibling rows; new
  cadence preset; new host that needs to compose recurrence on its own form.
  SKIP for unrelated transactions CRUD that doesn't touch recurrence,
  generic LOV / tenant_values work, the imports matcher chain (use
  imports-map for that), or anything outside `features/recurrences/`,
  `features/transactions/`, `api/services/recurrence-generate.ts`,
  `api/trpc/routers/recurrences.router.ts`, the `transaction_recurrences`
  table, or the `RECURRENCE_PATTERN` LOV.
---

# Recurrence map

Goal: keep the main context clean. The repo has a grep-friendly map at
`docs/design/recurrence-reference.md` that points each concept in the
recurrence utility to the small set of files that own it. Use it before
re-exploring.

## Workflow

1. **Grep the map first.** Section headings are stable and short:
   - `## Overview`
   - `## Convention for new callers`
   - `## Frontend primitives — features/transactions/`
   - `## Frontend primitives — features/recurrences/`
   - `## Hosts (assemble primitives, ~50–100 lines each)`
   - `## Backend mutation`
   - `## DB tables`
   - `## Seed`
   - `## Reconciliation`
   - `## Caches`
   - `## Common gotchas`
   - `## Where to extend`

   Use `Grep` (or `rg`) to land on the right section by keyword — do not
   `Read` the whole file. Examples:
   `rg -n "## Convention" docs/design/recurrence-reference.md`,
   `rg -n "## Common gotchas" docs/design/recurrence-reference.md`.

2. **Read only the files that section cites.** The map intentionally lists
   file paths and exported symbol names. Pull those, not their neighbours.

3. **Verify the symbol exists** before suggesting an edit. The map has no
   line numbers on purpose; if a symbol moved or was renamed, fix the code
   AND the map in the same change.

## When to update the map

Update `docs/design/recurrence-reference.md` in the same edit when you:

- add or rename a primitive hook / component in either feature folder;
- add a new host (a place that composes the primitives) — list its file
  under `## Hosts`;
- add or remove a column on `transaction_recurrences`;
- add a new RECURRENCE_PATTERN row that reflects a new cadence the user
  should know about (the map's `## DB tables` section names them);
- change `ALWAYS_HORIZON_MONTHS` or `MAX_OCCURRENCES` in
  `api/services/recurrence-generate.ts`;
- change the validation contract on `useTransactionFormState.buildSourcePayload`
  or `useRecurrenceConfigState.buildConfig` (the `{ ok, value | error }` shape).

Keep edits to one short section. The doc is a map, not a tutorial — no
code excerpts, no line numbers, one-line "what it does" per symbol.

## When the user wants a new host

The convention is documented in the map under `## Convention for new callers`
— hand the user that snippet and the cited primitive paths, then write the
host file as ~50–100 lines that composes hooks + components + a submit
handler. Don't reach into `features/recurrences/` internals; only consume
the exported hook + the exported `<RecurrenceModeFields>` component.

## Boundary

- Anything about the imports matcher chain (auto-fill, candidates query,
  reconciliation scoring) → consult `docs/design/imports-reference.md` via
  the `imports-map` skill, not this map.
- Generic LOV / tenant_values questions unrelated to RECURRENCE_PATTERN →
  consult `CLAUDE.md` and `docs/design/database.md` directly.
- The implementation tech plan (the why, the alternatives, the AC mapping)
  for recurrence is not yet a separate `M-XX-*-tech-plan.md` doc; this
  reference is currently the only navigation index.
