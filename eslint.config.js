import js from "@eslint/js";
import tsPlugin from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

// Shared rules enforced across both .ts and .tsx. The two file groups below
// differ only in (1) max-lines-per-function + complexity limits (JSX needs
// more room) and (2) React plugin wiring.
const sharedRules = {
  // Code style — hard errors
  "no-console": ["error", { allow: ["warn", "error"] }],
  "no-debugger": "error",
  "no-duplicate-imports": "error",
  "prefer-const": "error",

  // Auth provider boundary: only the auth adapter folders may import @clerk/*.
  // Reset to "off" inside app/src/auth/** and api/lib/auth-provider/** below.
  "no-restricted-imports": [
    "error",
    {
      patterns: [
        {
          group: ["@clerk/*"],
          message:
            "Import from '@/auth' (frontend) or 'api/lib/auth-provider' (backend) instead. The auth provider is an adapter — direct @clerk/* imports are confined to those two folders so we can swap providers later.",
        },
      ],
    },
  ],

  // TypeScript baseline
  "no-unused-vars": "off",
  "@typescript-eslint/no-unused-vars": [
    "error",
    { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
  ],
  "@typescript-eslint/no-explicit-any": "error",
  "@typescript-eslint/no-non-null-assertion": "error",
  "@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports" }],
  "@typescript-eslint/explicit-module-boundary-types": "error",

  // Type-aware — promises / thenables
  "@typescript-eslint/no-floating-promises": "error",
  "@typescript-eslint/no-misused-promises": "error",
  "@typescript-eslint/await-thenable": "error",

  // Type-aware — narrowing / assertions
  "@typescript-eslint/no-unnecessary-type-assertion": "error",
  "@typescript-eslint/no-unnecessary-condition": "error",
  "@typescript-eslint/no-base-to-string": "error",
  "@typescript-eslint/restrict-template-expressions": "error",
  "@typescript-eslint/no-confusing-void-expression": "error",
  "@typescript-eslint/switch-exhaustiveness-check": "error",
  "@typescript-eslint/prefer-nullish-coalescing": "error",
  "@typescript-eslint/prefer-optional-chain": "error",

  // Type-aware — unsafe `any` propagation
  "@typescript-eslint/no-unsafe-assignment": "error",
  "@typescript-eslint/no-unsafe-call": "error",
  "@typescript-eslint/no-unsafe-member-access": "error",
  "@typescript-eslint/no-unsafe-return": "error",
  "@typescript-eslint/no-unsafe-argument": "error",

  // Boolean coercion — strict but pragmatic: allow nullable objects in
  // truthy checks (e.g. `if (user) { ... }` where user is `User | null`),
  // but NOT strings/numbers/booleans (those have too many footguns).
  "@typescript-eslint/strict-boolean-expressions": [
    "error",
    {
      allowString: false,
      allowNumber: false,
      allowNullableObject: true,
      allowNullableBoolean: false,
      allowNullableString: false,
      allowNullableNumber: false,
      allowAny: false,
    },
  ],
};

export default [
  {
    ignores: ["dist/", "node_modules/", ".aws-sam/", "drizzle/meta/", "app/src/components/ui/**", "vite.config.ts", "poc/**"],
  },
  js.configs.recommended,
  // TypeScript files (.ts) — strict function limits
  {
    files: [
      "app/src/**/*.ts",
      "api/**/*.ts",
      "shared/**/*.ts",
      "drizzle/**/*.ts",
      "scripts/**/*.ts",
      "drizzle.config.ts",
      "vitest.config.ts",
    ],
    languageOptions: {
      parser: tsPlugin.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: {
      "@typescript-eslint": tsPlugin.plugin,
    },
    rules: {
      ...sharedRules,
      "max-lines": ["error", { max: 500, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 100, skipBlankLines: true, skipComments: true }],
      "max-params": ["error", 8],
      "max-depth": ["error", 6],
      complexity: ["error", 15],
    },
  },
  // React components (.tsx) — relaxed function limits due to JSX verbosity
  {
    files: ["app/src/**/*.tsx"],
    languageOptions: {
      parser: tsPlugin.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        ecmaFeatures: { jsx: true },
      },
      globals: globals.browser,
    },
    plugins: {
      "@typescript-eslint": tsPlugin.plugin,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...sharedRules,
      "max-lines": ["error", { max: 500, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 250, skipBlankLines: true, skipComments: true }],
      "max-params": ["error", 8],
      "max-depth": ["error", 6],
      complexity: ["error", 25],

      // React — errors, not warnings
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "react-refresh/only-export-components": ["error", { allowConstantExport: true }],
      "no-undef": "off",
    },
  },
  // Auth adapter folders: allow direct @clerk/* imports (this is where the
  // adapter lives, by design).
  {
    files: ["app/src/auth/**/*.{ts,tsx}", "api/lib/auth-provider/**/*.ts"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  // Tx-scope guard: every CRUD verb inside a transaction callback must run
  // on the tx-bound handle (txDb / tx), never on ctx.db. ctx.db reaches for
  // the outer pool and deadlocks on Lambda's max=1 connection budget while
  // the tx already holds the only connection. Use:
  //   ctx.db.transaction(async (txDb, tx) => { await txDb.byId(...) })
  {
    files: ["api/**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...["byId", "list", "create", "update", "softDelete", "restore"].map((verb) => ({
          selector: `CallExpression[callee.property.name="transaction"] CallExpression[callee.object.object.name="ctx"][callee.object.property.name="db"][callee.property.name="${verb}"]`,
          message: `Do not call ctx.db.${verb}(...) inside a transaction callback — use the txDb parameter from ctx.db.transaction((txDb, tx) => ...). ctx.db reaches the outer pool and deadlocks on Lambda's max=1 connection.`,
        })),
        {
          selector: `CallExpression[callee.property.name="transaction"] CallExpression[callee.object.object.object.name="ctx"][callee.object.object.property.name="db"][callee.object.property.name="lov"][callee.property.name="list"]`,
          message:
            "Do not call ctx.db.lov.list(...) inside a transaction callback — use txDb.lov.list from ctx.db.transaction((txDb, tx) => ...).",
        },
      ],
    },
  },
];
