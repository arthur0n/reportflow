// api/trpc/procedures.ts
//
// Three procedure tiers (project_conventions §7). All three are real, enforced
// from day 1.
//
//   publicProcedure        — no auth (health checks).
//   protectedProcedure     — verified JWT WITH an org_id claim AND a
//                            provisioned local `users` row for
//                            (open_id, tenant_id). Builds ctx.db, the scoped
//                            DB handle.
//   adminProcedure         — protected + users.role in ('admin','platform_admin').
//                            Tenant-scoped admin surfaces (e.g. the account's
//                            own LOV management) — still reads/writes only
//                            ctx.tenantId's rows.
//   platformAdminProcedure — protected + users.role === 'platform_admin'.
//                            Platform-admin-only surfaces. These MUST only
//                            touch SYSTEM rows (tenant_id IS NULL) — never
//                            "all tenants" or an arbitrary tenant's rows.
//
// There is no scope-bypass tier and no unscoped `adminDb` handle
// (decisions §2): a platform admin gets a wider menu, never a wider WHERE.
// Admin surfaces read `global` / `lov` tables, which carry no tenant rows of
// their own.

import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { Context, Role } from "./context";
import { createScopedDb, type ScopedDb } from "../db/scoped-client";

const t = initTRPC.context<Context>().create({ transformer: superjson });

const ADMIN_ROLES: readonly Role[] = ["admin", "platform_admin"];

export const router = t.router;
export const publicProcedure = t.procedure;

export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (ctx.tenantId === null || ctx.userId === null || ctx.role === null) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  const scopedDb: ScopedDb = createScopedDb({
    userId: ctx.userId,
    tenantId: ctx.tenantId,
  });
  return next({
    ctx: {
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      role: ctx.role,
      db: scopedDb,
    },
  });
});

export const adminProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!ADMIN_ROLES.includes(ctx.role)) {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
  return next({ ctx });
});

/**
 * Platform-admin-only tier (decisions §2). Distinct from `adminProcedure`:
 * a tenant `admin` never qualifies here. Procedures built on this tier must
 * only read/write SYSTEM rows (tenant_id IS NULL) — there is no "all tenants"
 * or cross-tenant scope for a platform admin to reach for.
 */
export const platformAdminProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (ctx.role !== "platform_admin") {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
  return next({ ctx });
});
