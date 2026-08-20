// api/trpc/router.ts
//
// Root router. Domain routers live in api/trpc/routers/ and get merged here.
// Keep this file thin — one line per domain router.

import { router, publicProcedure } from "./procedures";
import { usersRouter } from "./routers/users.router";
import { membershipsRouter } from "./routers/memberships.router";
import { tenantsRouter } from "./routers/tenants.router";
import { adminLovRouter } from "./routers/admin-lov.router";
import { listOfValuesRouter } from "./routers/list-of-values.router";
import { statementImportsRouter } from "./routers/statement-imports.router";
import { statementImportRowsRouter } from "./routers/statement-import-rows.router";
import { transactionsRouter } from "./routers/transactions.router";
import { categoriesRouter } from "./routers/categories.router";
import { dreGroupsRouter } from "./routers/dre-groups.router";
import { paymentMethodsRouter } from "./routers/payment-methods.router";
import { transactionSubtypesRouter } from "./routers/transaction-subtypes.router";
import { recurrencesRouter } from "./routers/recurrences.router";
import { tenantValuesRouter } from "./routers/tenant-values.router";
import { questionsRouter } from "./routers/questions.router";
import { importMatchRulesRouter } from "./routers/import-match-rules.router";
import { conciliationRouter } from "./routers/conciliation.router";
import { onboardingRouter } from "./routers/onboarding.router";

export const appRouter = router({
  health: publicProcedure.query(() => ({ status: "ok" as const })),

  onboarding: onboardingRouter,
  users: usersRouter,
  memberships: membershipsRouter,
  tenants: tenantsRouter,
  adminLov: adminLovRouter,
  listOfValues: listOfValuesRouter,
  statementImports: statementImportsRouter,
  statementImportRows: statementImportRowsRouter,
  transactions: transactionsRouter,
  categories: categoriesRouter,
  dreGroups: dreGroupsRouter,
  paymentMethods: paymentMethodsRouter,
  transactionSubtypes: transactionSubtypesRouter,
  recurrences: recurrencesRouter,
  tenantValues: tenantValuesRouter,
  questions: questionsRouter,
  importMatchRules: importMatchRulesRouter,
  conciliation: conciliationRouter,
});

export type AppRouter = typeof appRouter;
