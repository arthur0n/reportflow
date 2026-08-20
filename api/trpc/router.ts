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
import { tenantValuesRouter } from "./routers/tenant-values.router";
import { onboardingRouter } from "./routers/onboarding.router";

export const appRouter = router({
  health: publicProcedure.query(() => ({ status: "ok" as const })),

  onboarding: onboardingRouter,
  users: usersRouter,
  memberships: membershipsRouter,
  tenants: tenantsRouter,
  adminLov: adminLovRouter,
  listOfValues: listOfValuesRouter,
  tenantValues: tenantValuesRouter,
});

export type AppRouter = typeof appRouter;
