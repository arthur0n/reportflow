// api/db/admin-client.ts
//
// Cross-tenant DB handle. Importing this file is the explicit "I am crossing
// tenants" signal.
// Used by:
//   - api/routes/webhook-routes.ts  (Clerk webhook — pre-tenant-context writes)
//   - scripts/seed.ts                (system seed)
//   - platformAdminProcedure handlers
//
// TODO: when RLS lands, this connects with a separate Postgres role that has
// BYPASSRLS. Today, same role/connection as the scoped ctx.db — the
// import-time signal is the contract, not the runtime difference.

import { db } from "./client";

export const adminDb = db;
