// api/trpc/procedures.ts
//
// Five procedure tiers. Cross-tenant access happens only via memberships
// (with optional expires_at) — no platform-role / adminDb-backed tier.
//
//   publicProcedure        — no auth (health checks).
//   verifiedProcedure      — JWT-verified, ctx.externalUserId only. No local
//                            users row required. Used by onboarding.createTenant
//                            so the bootstrap can run during the signup race
//                            window before user.created webhook lands.
//   authenticatedProcedure — JWT-verified AND local users row present
//                            (ctx.userId). Used by users.me, users.switchTenant,
//                            users.listMyMemberships, memberships.accept.
//   protectedProcedure     — authenticated + active membership for active
//                            tenant. Builds ctx.db (the scoped DB handle).
//   adminProcedure         — protected + ctx.role <= MEMBERSHIP_RANK.REPORTFLOW.
//                            Gates the admin menu (system catalog management,
//                            cross-tenant LOV admin). NOT a data backdoor:
//                            ctx.db still scopes by ctx.tenantId.

import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { Context } from "./context";
import { createScopedDb, type ScopedDb } from "../db/scoped-client";
import { MEMBERSHIP_RANK } from "../../shared/constants/membership-roles";

const t = initTRPC.context<Context>().create({ transformer: superjson });

export const router = t.router;
export const publicProcedure = t.procedure;

export const verifiedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (ctx.externalUserId === null) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: {
      externalUserId: ctx.externalUserId,
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      tenantIndustry: ctx.tenantIndustry,
      role: ctx.role,
    },
  });
});

export const authenticatedProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (ctx.userId === null) {
    throw new TRPCError({ code: "UNAUTHORIZED" });
  }
  return next({
    ctx: {
      externalUserId: ctx.externalUserId,
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      tenantIndustry: ctx.tenantIndustry,
      role: ctx.role,
    },
  });
});

export const protectedProcedure = authenticatedProcedure.use(async ({ ctx, next }) => {
  if (ctx.tenantId === null || ctx.tenantIndustry === null || ctx.role === null) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "no active tenant membership",
    });
  }
  const scopedDb: ScopedDb = createScopedDb({
    userId: ctx.userId,
    tenantId: ctx.tenantId,
    tenantIndustry: ctx.tenantIndustry,
  });
  return next({
    ctx: {
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      tenantIndustry: ctx.tenantIndustry,
      role: ctx.role,
      db: scopedDb,
    },
  });
});

export const adminProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (ctx.role > MEMBERSHIP_RANK.REPORTFLOW) {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
  return next({ ctx });
});
