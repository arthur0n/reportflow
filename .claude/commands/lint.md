# Lint (strict)

Run ESLint with `--max-warnings 0`. Any warning is treated as an error. Includes the full type-aware rule set (`no-floating-promises`, `no-misused-promises`, `strict-boolean-expressions`, `no-unsafe-*`, `prefer-nullish-coalescing`, `prefer-optional-chain`, `switch-exhaustiveness-check`, etc.).

```bash
pnpm lint
```

To auto-fix what can be fixed:

```bash
pnpm lint:fix
```

**Rule of thumb:** if a rule flags something, the fix is in the source code, not the config. Only relax a rule after discussing it and updating `docs/project_conventions.md`.
