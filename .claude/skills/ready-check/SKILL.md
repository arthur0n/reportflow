---
name: ready-check
description: |
  Use BEFORE telling the user that work is "done", "ready", "shipped", "complete",
  "good to go", "validated", "all set", before any /commit or /push, before
  closing out an implementation turn that touched code, and before declaring a
  bug fixed. Solo-dev project: every code change MUST exit `pnpm validate`
  cleanly before the agent says it is ready. The pre-push hook also runs
  validate, but discovering a regression at push time wastes a turn — catch it
  at the source. SKIP for: documentation-only edits (.md), pure read/answer
  turns with no code changes, plan-mode exploration, and turns that ended in a
  blocker the user already knows about.
---

# Ready check

Solo-dev quality gate. The harness does not enforce this — you do. Skipping
`pnpm validate` and declaring work "done" is the single biggest source of
broken `main` in this repo.

## Hard rule

Before any of the following, run `pnpm validate` and confirm exit 0:

- end-of-turn summary that implies the work is finished ("all clean", "ready
  to push", "feature shipped", "validate passes", "fixed", "done")
- creating a git commit
- pushing a branch
- handing the work back to the user with no open questions

`pnpm validate` runs `pnpm check && pnpm lint && pnpm test` (`package.json`).
All three must exit 0. No exceptions, no `--no-verify`, no scoped re-runs as
a substitute (running only `pnpm check` is not enough — lint and tests must
pass too).

## When validate fails

1. Read the actual error output. Don't guess.
2. Fix the underlying issue:
   - **type errors**: change the type, not the runtime — `as any` and
     `// @ts-ignore` are not fixes.
   - **lint caps** (function lines, complexity, file lines, max-warnings 0):
     refactor. The caps exist because functions over them tend to grow into
     500-line gods. Split.
   - **test failures**: fix the code under test or update the test if the new
     behavior is intentional. Never delete a test to silence it.
   - **`eslint-disable-next-line` to silence a rule is forbidden** unless you
     explain in the comment why the rule does not apply here AND the user
     agrees. Default: refactor.
3. Re-run `pnpm validate`.
4. Loop until exit 0.

## When the linter/formatter touches files mid-commit

`lint-staged` runs Prettier + ESLint --fix on staged files at commit time.
Those auto-modifications can introduce new lint errors (e.g. formatting nudges
a function past the line cap). After every commit that involved a code file,
**re-run `pnpm validate`**. If it fails, create a NEW commit with the fix
(never amend — see project policy in CLAUDE.md).

## Project-specific strictness this catches

`pnpm lint` runs `eslint . --max-warnings 0`. Live constraints:

- `max-lines-per-function`: 100 for hooks, 250 for components / module
  functions
- `max-lines`: 500 per file
- `complexity`: 15 (counts `if`, `??`, `||`, `&&`, ternary, `case`, `catch`,
  loops)
- `@typescript-eslint/no-unnecessary-condition`
- `@typescript-eslint/prefer-nullish-coalescing`
- `@typescript-eslint/prefer-optional-chain`
- `exactOptionalPropertyTypes` in `tsconfig.json` — `prop?: T` does NOT
  accept `T | undefined`; type explicitly as `prop?: T | undefined` or stop
  passing `undefined` at the call site.

When you split a function, prefer:

1. Extract a helper with a clear name (a `useTransactionFieldStates` sub-hook
   beats a 300-line component).
2. Extract a sub-component for a distinct UI section (a 7-button cluster
   becomes a `<DecisionButtons>` component).
3. Push the branchy logic out of a hot function into pure helpers (e.g.
   `withDefaults` / `nonNullFks` patterns).

## Workflow checklist

```
[ ] Code change made
[ ] pnpm validate          # exit 0
[ ] Summary written, commit message drafted
[ ] git commit             # lint-staged may modify files
[ ] pnpm validate          # exit 0 (catches lint-staged surprises)
[ ] git push               # pre-push runs validate again as a backstop
```

If you skip step 4's re-validate and the commit shows in `git log` but
`pnpm validate` would fail, fix it in a new commit immediately. Never
declare the work ready until validate is green on the actual HEAD that will
be pushed.

## Out of scope

- `.md`-only edits (docs, plans, CLAUDE.md) — no validate required, but read
  the file back to confirm formatting.
- Read/explore/answer turns with no `Edit` or `Write` calls.
- Plan mode (no edits possible there anyway).
- Turns that end with an unresolved error you've already surfaced to the
  user — don't pretend it passed.
