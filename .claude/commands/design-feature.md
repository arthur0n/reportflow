# Design Feature (Tech Plan)

**Brainstorm a feature design with the user, then write a tech plan.** This is creative design work: we are exploring the problem space, challenging the BA's framing, and committing to one normalized solution before any code is written.

## Request

$ARGUMENTS

If the request is empty or ambiguous (e.g. only "M6"), STOP and ask the user which BA file you should treat as the input before doing anything else. Do not guess.

---

## Posture

- **The user is the SE (Solution Engineer).** They own schema, API, file layout, migrations, tests. The PO is a separate, downstream reader who only sees the BA doc's "Perguntas Abertas". Ask the user about implementation forks; route business-policy questions to the BA doc for the PO.
- **Greenfield, no back-compat.** Pre-MVP. Rename, rebuild, re-seed. No deprecated aliases, no transition shims, no "(removed)" / "legacy" / "for now" comments.
- **BA docs are inputs, not specs.** The PO does not write code. Treat denormalization, copy-paste fields, and Excel-shaped tables as smell, not requirement. Restate the business rule in normalized form before locking decisions.
- **Skeleton may already exist.** Check before designing. If a partial implementation is present, the plan deletes/rebuilds it on the canonical pattern (see `docs/design/M-05-creditors-tech-plan.md` for precedent).
- **Solo developer, no bloat.** No multi-phase rollouts. No 5-step build pipelines. One plan, one PR series, one canonical pattern. Always check for reuse before adding a new abstraction.
- **Ask, don't guess.** When the BA is ambiguous, the conventions are silent, or two paths look equally valid, stop and ask. Capitulating without re-examining is worse than asking.

---

## Step 1 — Force plan mode and invoke brainstorming (BEFORE any file read)

**Do these two things first, in this order, before reading a single file or running any other tool.** Reading files directly in the main context fills it with noise; all investigation must happen in subagent contexts (Step 2).

1. Call `EnterPlanMode`. Stay in plan mode through user approval of the tech plan.
2. Invoke the `superpowers:brainstorming` skill via the `Skill` tool. The brainstorming target is: _what is the smallest, most-normalized implementation that satisfies the BA's underlying intent and respects the conventions?_ — NOT _how do we faithfully re-implement what the BA wrote?_.

If you find yourself reaching for `Read` or `Grep` directly in this command, stop — that work belongs to a Step 2 subagent.

## Step 2 — Dispatch parallel investigation subagents

Send a single message with multiple `Agent` tool calls (`subagent_type: Explore`) so they run concurrently. Each subagent reports back in under ~300 words. Brief them like cold colleagues — they cannot see this conversation. Their summaries are what enters the main context; the raw file contents stay in their isolated contexts.

**Required subagents (run in parallel):**

1. **BA reader.** Read `docs/ba-docs/M-XX-*.md` for the requested module + `docs/ba-docs/CONVENTIONS.md`. Report: business intent (in 5 bullets), every RF/RN, every CA, every "Pergunta Aberta", and any field/rule that smells like an Excel artifact (denormalized columns, propagation rules, hardcoded enums, copy-paste between tables). Flag — do not silently absorb — anything that looks like a JOIN dressed up as a column.

2. **Conventions reader.** Read `CLAUDE.md`, `docs/design/conventions.md`, `docs/design/tech-plan-convention.md`, `docs/design/architecture.md`, `docs/design/database.md`, `docs/design/authentication.md`. Report: the NEVER/ALWAYS rules that apply to this module, the system-fields contract, the scope-helper contract, the LOV contract, and the tech-plan section list.

3. **Skeleton + reuse scout.** Search `drizzle/schema.ts`, `api/db/scope.ts`, `api/trpc/routers/`, `api/services/`, `app/src/features/`, `app/src/shared/`, `shared/validation/`. Report: any existing tables/routers/components/hooks/Zod schemas that touch this module's domain, and any cross-feature utility (e.g. `useLov`, `useListPage`, `lov-crud`, `audit.ts`, `slugify.ts`) the plan should reuse instead of recreating. Call out skeletons that pre-date the conventions and need rebuilding.

4. **Precedent reader.** Read the most recent approved tech plans (`docs/design/M-04-categories-tech-plan.md`, `docs/design/M-05-creditors-tech-plan.md`). Report: the structural pattern they share — section order, decision-table shape, how schema diffs / migrations / AC mapping are presented — so the new plan matches voice and shape.

Wait for all four to return before continuing. Do **not** duplicate their work yourself.

## Step 3 — Brainstorm with the user

Out loud, in plan mode, run the brainstorming loop:

1. **Restate the BA's intent in normalized form.** One paragraph. If the BA proposed a denormalized table, propose the JOIN. If the BA proposed propagation logic, propose the relationship. If the BA proposed a new lookup table, check whether `list_of_values` already covers it.
2. **List the smells you flagged** from the BA reader's report and how the plan resolves each (absorb / push back to PO / defer to follow-up). Use the `[INVALIDATED] / [ANSWERED] / [OPEN]` tags from `docs/ba-docs/CONVENTIONS.md §3`.
3. **List the reusable pieces** from the scout's report and where each is used.
4. **List the open questions for the user** — both PO-business questions (will go into the BA doc's "Perguntas Abertas") and SE-implementation forks where you want the user's call. Ask before locking.
5. **Propose convention/doc updates** that fall out of this work. Any new NEVER/ALWAYS rule, any naming clarification, any pattern that would have prevented a smell — name the exact file (`CLAUDE.md`, `docs/design/conventions.md`) and the exact wording, the way `M-05-creditors-tech-plan.md §Pre-flight` does. Convention updates land in the same PR as the plan, not later.

Wait for user answers on the open questions. Do not proceed with a plan that still has SE-internal forks open.

## Step 4 — Write the tech plan

File: `docs/design/M-XX-<topic>-tech-plan.md` (kebab-case topic from the BA filename). Status header: `Draft`.

Sections, in order, per `docs/design/tech-plan-convention.md`:

1. Status / Tier / BA reference
2. Context and non-goals
3. Decisions (table, one-line rationale per row, decisive — no "could / depending")
4. Schema changes (Drizzle diff, `TABLE_SCOPE` entry, system fields per `CLAUDE.md`, soft-delete rules, indexes; migration filename called out)
5. API surface (tRPC procedures: input/output shape, scoping, BA RF/RN it implements; default `protectedProcedure`; caching where relevant)
6. Frontend surface (pages/hooks/components; reference the existing pattern they match; pt-BR copy)
7. Data flow (skip if trivial)
8. Verification (AC mapping table + local `pnpm validate` checklist)
9. Out of scope / follow-ups
10. Open questions (empty by Approved; only PO-business questions allowed)

If a pre-flight convention fix is needed (new NEVER/ALWAYS rule, doc correction), add a `## ⚠️ Pre-flight convention fix` block above §1 with the exact wording to land in `CLAUDE.md` / `docs/design/conventions.md`, mirroring the M-05 plan's format.

## Step 5 — Exit plan mode for approval

Present the plan via `ExitPlanMode`. The user approves before any file is written outside the plan itself.

---

## Hard rules

- **NEVER** read files directly in the main context during Steps 1–3 — investigation belongs to Step 2 subagents so the main context stays clean.
- **NEVER** absorb a BA-proposed denormalized column without first checking whether it is a JOIN.
- **NEVER** add a table without a matching `TABLE_SCOPE` entry decision in §4.
- **NEVER** propose `publicProcedure` unless §3 justifies it.
- **NEVER** propose a `metadata jsonb` column on `list_of_values` or any catch-all blob.
- **NEVER** write back-compat shims, deprecated aliases, "until the follow-up" comments, or "(removed)" / "legacy" / "for now" markers — pre-MVP, this is greenfield.
- **NEVER** add a `motivo` / `reason` field to soft-delete or audit rows.
- **ALWAYS** include the four system fields (`created_at, created_by, last_upd_at, last_upd_by`) on every new table; soft-deleted tables additionally carry `deleted_at, deleted_by`.
- **ALWAYS** route LOV-shaped data through `list_of_values` with `type` in `UPPER_SNAKE_CASE`, dedup via `(tenant_id, type, code)`, slug via `shared/validation/slugify.ts` through `api/services/lov-crud.ts`.
- **ALWAYS** write audit rows from mutating procedures via `writeAuditEntry` (`api/services/audit.ts`).
- **ALWAYS** check `app/src/shared/`, `shared/validation/`, `api/services/` for reusable code before introducing a new one.
- **ALWAYS** propose convention updates in the same PR as the plan that surfaced the gap.
