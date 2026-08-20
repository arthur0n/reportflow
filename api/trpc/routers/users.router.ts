// api/trpc/routers/users.router.ts
//
// Identity-tier endpoints. All three procedures live on authenticatedProcedure
// because picking / inspecting tenant membership cannot itself require an
// active tenant. The authenticated tier exposes ctx.userId (always set) but no
// ctx.db — we use `db` from api/db/client.ts directly here.

import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { and, asc, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import { router, authenticatedProcedure } from "../procedures";
import { db } from "../../db/client";
import { memberships, tenants, users } from "../../../drizzle/schema";
import { writeAuditEntry } from "../../services/audit";

export const usersRouter = router({
  /** Current user + active tenant joined (LEFT JOIN: active tenant may be NULL). */
  me: authenticatedProcedure.query(async ({ ctx }) => {
    const [row] = await db
      .select({
        userId: users.id,
        email: users.email,
        name: users.name,
        activeTenantId: users.activeTenantId,
        activeTenantName: tenants.name,
        activeTenantMode: tenants.mode,
      })
      .from(users)
      .leftJoin(tenants, eq(tenants.id, users.activeTenantId))
      .where(eq(users.id, ctx.userId))
      .limit(1);

    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: "user not found" });
    }

    return {
      userId: row.userId,
      email: row.email,
      name: row.name,
      activeTenantId: row.activeTenantId,
      activeTenantName: row.activeTenantName,
      // Drives the import-only UI gate; null when no active tenant.
      activeTenantMode: row.activeTenantMode,
      // ctx.role is the active membership's rank (or null if no active membership).
      role: ctx.role,
    };
  }),

  /**
   * Switch the user's active tenant. Verifies the membership is joined,
   * non-expired, non-deleted before flipping users.active_tenant_id. The
   * mutation + audit row are wrapped in a transaction so the audit trail can
   * never disagree with the persisted state.
   */
  switchTenant: authenticatedProcedure
    .input(z.object({ tenantId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return db.transaction(async (tx) => {
        const [membership] = await tx
          .select({ id: memberships.id })
          .from(memberships)
          .where(
            and(
              eq(memberships.userId, ctx.userId),
              eq(memberships.tenantId, input.tenantId),
              isNull(memberships.deletedAt),
              isNotNull(memberships.joinedAt),
              or(isNull(memberships.expiresAt), gt(memberships.expiresAt, sql`now()`)),
            ),
          )
          .limit(1);

        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "no active membership for this tenant",
          });
        }

        const [priorRow] = await tx
          .select({ activeTenantId: users.activeTenantId })
          .from(users)
          .where(eq(users.id, ctx.userId))
          .limit(1);

        if (!priorRow) {
          throw new TRPCError({ code: "NOT_FOUND", message: "user not found" });
        }
        const priorTenantId = priorRow.activeTenantId;

        await tx
          .update(users)
          .set({
            activeTenantId: input.tenantId,
            lastUpdAt: new Date().toISOString(),
            lastUpdBy: ctx.userId,
          })
          .where(eq(users.id, ctx.userId));

        await writeAuditEntry({
          ctx: { tenantId: input.tenantId, userId: ctx.userId },
          entityType: "USER_ACTIVE_TENANT",
          entityId: ctx.userId,
          action: "TENANT_SWITCH",
          before: { activeTenantId: priorTenantId },
          after: { activeTenantId: input.tenantId },
          tx,
        });

        return { tenantId: input.tenantId };
      });
    }),

  /**
   * Active memberships for the current user. Filtered server-side to joined,
   * non-expired, non-deleted rows; isActive is always true today, kept on the
   * shape so the UI can grow a "pending invites" tab without a schema change.
   */
  listMyMemberships: authenticatedProcedure.query(async ({ ctx }) => {
    const rows = await db
      .select({
        membershipId: memberships.id,
        tenantId: memberships.tenantId,
        tenantName: tenants.name,
        role: memberships.role,
        expiresAt: memberships.expiresAt,
      })
      .from(memberships)
      .innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(
        and(
          eq(memberships.userId, ctx.userId),
          isNull(memberships.deletedAt),
          isNotNull(memberships.joinedAt),
          or(isNull(memberships.expiresAt), gt(memberships.expiresAt, sql`now()`)),
        ),
      )
      .orderBy(asc(tenants.name));

    return rows.map((r) => ({
      membershipId: r.membershipId,
      tenantId: r.tenantId,
      tenantName: r.tenantName,
      role: r.role,
      expiresAt: r.expiresAt === null ? null : new Date(r.expiresAt),
      isActive: true,
    }));
  }),
});
