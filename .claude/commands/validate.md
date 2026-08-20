# Validate (CI aggregate)

Runs `pnpm check && pnpm lint && pnpm test` — the same pipeline the pre-push hook runs and the same one `.github/workflows/validate.yml` runs on every PR. If this is green, the branch is safe to push.

```bash
pnpm validate
```

If it fails, fix the root cause — do NOT bypass with `--no-verify` on the eventual commit/push.
