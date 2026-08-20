---
name: imports-map
description: |
  Use when the user's request touches the bank-statement imports flow in this repo.
  TRIGGER on any of: bank-statement / statement_import / OFX / CSV import; matcher
  chain or strategies (exact-code, rule, learned-decision, trigram-fuzzy, ai); the
  classifier targets paymentMethod / category / supplier / customer / subtype on an
  import row; auto-fill at parse time; the review UI (ReviewRows, ReviewableSection,
  ReviewableRow, InlineRefPicker, ClassificationFieldCell); quick-create / "Criar"
  affordance from a picker; description normalization (normalizeForMatch,
  cleanDescriptionForCreate, DESCRIPTION_NOISE); import_match_rules /
  import_match_decisions; the orchestrator / processImport / runChainForTargets;
  thresholds AUTO_APPLY_THRESHOLD / SUGGEST_THRESHOLD / SHORT_CIRCUIT_THRESHOLD /
  CONF_CEIL; statement-imports / statement-import-rows tRPC routers.
  SKIP for unrelated LOV / tenant_values work, generic Drizzle questions, or any
  feature outside `api/imports/`, `app/src/components/imports/`, `app/src/features/`
  picker dialogs, or the `import_*` tables.
---

# Imports map

Goal: keep the main context clean. The repo has a grep-friendly map at
`docs/design/imports-reference.md` that points each concept in the imports flow
to the small set of files that own it. Use it before re-exploring.

## Workflow

1. **Grep the map first.** Section headings are stable and short:
   - `## Overview`
   - `## Stage: Upload` / `## Stage: Parse` / `## Stage: Auto-fill (parse-time)` / `## Stage: Review` / `## Stage: Recording` / `## Stage: Promotion to transactions`
   - `## Auto-fill: chain` / `## Auto-fill: strategies` / `## Auto-fill: thresholds`
   - `## Description normalization`
   - `## Quick-create (Criar)`
   - `## DB tables`
   - `## DESCRIPTION_NOISE LOV`
   - `## Caches`
   - `## Common gotchas`
   - `## Where to extend`

   Use `Grep` (or `rg`) to land on the right section by keyword — do not `Read`
   the whole file. Examples: `rg -n "## Auto-fill" docs/design/imports-reference.md`,
   `rg -n "Quick-create" docs/design/imports-reference.md`.

2. **Read only the files that section cites.** The map intentionally lists
   file paths and exported symbol names. Pull those, not their neighbours.

3. **Verify the symbol exists** before suggesting an edit. The map has no line
   numbers on purpose; if a symbol moved or was renamed, fix the code AND the
   map in the same change.

## When to update the map

Update `docs/design/imports-reference.md` in the same edit when you:

- add or rename a matcher strategy, parser, or classifier target;
- introduce a new LOV `type` consumed by the imports flow (e.g. another `DESCRIPTION_*`);
- add a new picker / dialog wired into `ReviewableSection`;
- change a chain threshold or trigram remap constant;
- add a new cache bust point.

Keep edits to one short section. The doc is a map, not a tutorial — no code
excerpts, no line numbers, one-line "what it does" per symbol.

## Boundary

- Generic LOV / tenant_values questions unrelated to imports → consult
  `CLAUDE.md` and `docs/design/database.md` directly, not this map.
- The design _plan_ (the why, the alternatives, the AC mapping) lives in
  `docs/design/M-11-statement-imports-tech-plan.md`. The map is the _index_.
  Read the plan when the user is reasoning about a past decision; read the map
  when the user is asking where the code lives or how to extend it.
