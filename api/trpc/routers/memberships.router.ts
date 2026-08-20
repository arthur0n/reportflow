// api/trpc/routers/memberships.router.ts
//
// Per-tenant membership lifecycle: list, invite, accept, revoke, changeRole.
// `list` / `revoke` / `changeRole` run on adminProcedure (owner | admin role
// in the active tenant). `invite` is admin too. `accept` runs on the
// authenticated tier because the invitee may not yet have an active tenant.
//
// Last-owner guard: a tenant must always have at least one joined, non-deleted
// owner. Revoking or demoting the final owner throws PRECONDITION_FAILED.

import { z } from "zod/v4";
import { TRPCError } from "@trpc/server";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { router, authenticatedProcedure, protectedProcedure, adminProcedure } from "../procedures";
import { db } from "../../db/client";
import { memberships, users } from "../../../drizzle/schema";
import { writeAuditEntry } from "../../services/audit";
import { MEMBERSHIP_RANK } from "../../../shared/constants/membership-roles";

const RoleInput = z.number().int().min(0);

/** Count joined, non-deleted admin-or-higher members in a tenant. Used to
 * prevent revoking/demoting the last admin. ReportFlow members (rank 0) count
 * — the tenant always has at least one member with admin authority. */
async function countActiveAdmins(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  tenantId: string,
): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(memberships)
    .where(
      and(
        eq(memberships.tenantId, tenantId),
        lte(memberships.role, MEMBERSHIP_RANK.ADMIN),
        isNull(memberships.deletedAt),
      ),
    );
  return row?.n ?? 0;
}

export const membershipsRouter = router({
  /** Members of the active tenant. tenant + soft-delete scoping via ctx.db.scope. */
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.raw
      .select({
        membershipId: memberships.id,
        userId: users.id,
        userEmail: users.email,
        userName: users.name,
        role: memberships.role,
        joinedAt: memberships.joinedAt,
        expiresAt: memberships.expiresAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(ctx.db.scope(memberships))
      .orderBy(sql`${users.name} ASC NULLS LAST`);

    return rows.map((r) => ({
      membershipId: r.membershipId,
      userId: r.userId,
      userEmail: r.userEmail,
      userName: r.userName,
      role: r.role,
      joinedAt: r.joinedAt === null ? null : new Date(r.joinedAt),
      expiresAt: r.expiresAt === null ? null : new Date(r.expiresAt),
    }));
  }),

  /**
   * Invite by email. User identity is global — the lookup is unscoped. If no
   * user row exists yet we insert a stub keyed on email; when that person
   * signs up via Clerk the webhook merges external_id into the same row.
   */
  invite: adminProcedure
    .input(
      z.object({
        email: z.string().email(),
        role: RoleInput,
        expiresAt: z.string().datetime().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return db.transaction(async (tx) => {
        const [existingUser] = await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, input.email))
          .limit(1);

        let targetUserId: string;
        if (existingUser) {
          targetUserId = existingUser.id;
        } else {
          // Stub user — no external_id yet. The Clerk webhook resolves this
          // row by email/external_id when the invitee signs up. external_id
          // is NOT NULL in the schema, so write a placeholder unique value
          // tied to the email; the webhook's onConflictDoUpdate replaces it.
          const stubExternalId = `pending:${input.email}`;
          const [created] = await tx
            .insert(users)
            .values({
              externalId: stubExternalId,
              email: input.email,
              createdBy: ctx.userId,
              lastUpdBy: ctx.userId,
            })
            .returning({ id: users.id });
          if (!created) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "failed to create stub user",
            });
          }
          targetUserId = created.id;
        }

        const expiresAt = input.expiresAt ?? null;
        const now = new Date().toISOString();

        const inserted = await tx
          .insert(memberships)
          .values({
            userId: targetUserId,
            tenantId: ctx.tenantId,
            role: input.role,
            invitedBy: ctx.userId,
            joinedAt: null,
            expiresAt,
            createdAt: now,
            createdBy: ctx.userId,
            lastUpdAt: now,
            lastUpdBy: ctx.userId,
          })
          .onConflictDoNothing()
          .returning({ id: memberships.id });

        const [createdRow] = inserted;
        if (!createdRow) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "membership already exists for this user and tenant",
          });
        }

        await writeAuditEntry({
          ctx: { tenantId: ctx.tenantId, userId: ctx.userId },
          entityType: "MEMBERSHIP",
          entityId: createdRow.id,
          action: "MEMBERSHIP_INVITE",
          after: {
            userId: targetUserId,
            tenantId: ctx.tenantId,
            role: input.role,
            expiresAt,
          },
          tx,
        });

        return { membershipId: createdRow.id, userId: targetUserId };
      });
    }),

  /**
   * Accept a pending invitation. Atomic UPDATE … WHERE joined_at IS NULL so
   * a double-click cannot re-stamp joined_at, and a stranger cannot accept
   * someone else's invite.
   */
  accept: authenticatedProcedure
    .input(z.object({ membershipId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      return db.transaction(async (tx) => {
        const now = new Date().toISOString();
        const [updated] = await tx
          .update(memberships)
          .set({ joinedAt: now, lastUpdAt: now, lastUpdBy: ctx.userId })
          .where(
            and(
              eq(memberships.id, input.membershipId),
              eq(memberships.userId, ctx.userId),
              isNull(memberships.joinedAt),
              isNull(memberships.deletedAt),
            ),
          )
          .returning();

        if (!updated) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "membership not found or already accepted",
          });
        }

        await writeAuditEntry({
          ctx: { tenantId: updated.tenantId, userId: ctx.userId },
          entityType: "MEMBERSHIP",
          entityId: updated.id,
          action: "MEMBERSHIP_ACCEPT",
          after: {
            userId: updated.userId,
            tenantId: updated.tenantId,
            role: updated.role,
            joinedAt: now,
          },
          tx,
        });

        return { membershipId: updated.id, tenantId: updated.tenantId };
      });
    }),

  /**
   * Soft-delete a membership in the active tenant. Refuses to revoke the
   * tenant's last joined owner so the tenant is never left admin-less.
   */
  revoke: adminProcedure
    .input(z.object({ membershipId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.byId(memberships, input.membershipId);
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "membership not found" });
      }

      return ctx.db.transaction(async (txDb, tx) => {
        if (row.role <= MEMBERSHIP_RANK.ADMIN) {
          const admins = await countActiveAdmins(tx, ctx.tenantId);
          if (admins <= 1) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "cannot revoke the last admin",
            });
          }
        }

        const deleted = await txDb.softDelete(memberships, input.membershipId);
        if (!deleted) {
          throw new TRPCError({ code: "NOT_FOUND", message: "membership not found" });
        }

        await writeAuditEntry({
          ctx: { tenantId: ctx.tenantId, userId: ctx.userId },
          entityType: "MEMBERSHIP",
          entityId: row.id,
          action: "MEMBERSHIP_REVOKE",
          before: {
            userId: row.userId,
            tenantId: row.tenantId,
            role: row.role,
            joinedAt: row.joinedAt,
            expiresAt: row.expiresAt,
          },
          tx,
        });

        return { membershipId: row.id };
      });
    }),

  /**
   * Change a membership's role within the active tenant. Demoting the last
   * joined owner away from 'owner' is blocked by the same guard as revoke.
   */
  changeRole: adminProcedure
    .input(
      z.object({
        membershipId: z.string().uuid(),
        role: RoleInput,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.byId(memberships, input.membershipId);
      if (!row) {
        throw new TRPCError({ code: "NOT_FOUND", message: "membership not found" });
      }

      return ctx.db.transaction(async (txDb, tx) => {
        // Demoting an admin-or-higher to a lower rank? Make sure another
        // admin remains.
        if (row.role <= MEMBERSHIP_RANK.ADMIN && input.role > MEMBERSHIP_RANK.ADMIN) {
          const admins = await countActiveAdmins(tx, ctx.tenantId);
          if (admins <= 1) {
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: "cannot demote the last admin",
            });
          }
        }

        const updated = await txDb.update(memberships, input.membershipId, {
          role: input.role,
        });
        if (!updated) {
          throw new TRPCError({ code: "NOT_FOUND", message: "membership not found" });
        }

        await writeAuditEntry({
          ctx: { tenantId: ctx.tenantId, userId: ctx.userId },
          entityType: "MEMBERSHIP",
          entityId: row.id,
          action: "MEMBERSHIP_ROLE_CHANGE",
          before: { role: row.role },
          after: { role: input.role },
          tx,
        });

        return { membershipId: row.id, role: input.role };
      });
    }),
});
