// lint-staged.config.mjs
//
// eslint.config.js ignores `app/src/components/ui/**` (shadcn-generated).
// If lint-staged handed those paths to eslint, eslint would warn "file
// ignored by config" and the warning would fail --max-warnings 0.
// Mirror the ignore list here so eslint only ever sees files it's
// configured to lint.

const ESLINT_IGNORED_SEGMENT = "/app/src/components/ui/";
const ESLINT_IGNORED_FILES = ["/vite.config.ts"];
const ESLINT_IGNORED_DIRS = ["/poc/"];

function shouldLint(file) {
  return (
    !file.includes(ESLINT_IGNORED_SEGMENT) &&
    !ESLINT_IGNORED_FILES.some((suffix) => file.endsWith(suffix)) &&
    !ESLINT_IGNORED_DIRS.some((seg) => file.includes(seg))
  );
}

export default {
  "**/*.{ts,tsx}": (files) => {
    const target = files.filter(shouldLint);
    if (target.length === 0) return [];
    const quoted = target.map((f) => JSON.stringify(f)).join(" ");
    return [`eslint --max-warnings 0 --fix ${quoted}`, `prettier --write ${quoted}`];
  },
  "**/*.{json,md,yaml,yml,css}": ["prettier --write"],
};
