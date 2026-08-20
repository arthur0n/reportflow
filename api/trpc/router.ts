// api/trpc/router.ts
//
// Root router. Domain routers live in api/trpc/routers/ and get merged here.
// Keep this file thin — one line per domain router.

import { router, publicProcedure } from "./procedures";
import { usersRouter } from "./routers/users.router";
import { adminLovRouter } from "./routers/admin-lov.router";
import { listOfValuesRouter } from "./routers/list-of-values.router";
import { tenantValuesRouter } from "./routers/tenant-values.router";
import { documentsRouter } from "./routers/documents.router";
import { jobsRouter } from "./routers/jobs.router";
import { calibrationRouter } from "./routers/calibration.router";
import { extractionsRouter } from "./routers/extractions.router";

export const appRouter = router({
  health: publicProcedure.query(() => ({ status: "ok" as const })),

  users: usersRouter,
  adminLov: adminLovRouter,
  listOfValues: listOfValuesRouter,
  tenantValues: tenantValuesRouter,
  documents: documentsRouter,
  jobs: jobsRouter,
  calibration: calibrationRouter,
  extractions: extractionsRouter,
});

export type AppRouter = typeof appRouter;
