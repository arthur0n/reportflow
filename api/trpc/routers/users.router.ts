// api/trpc/routers/users.router.ts
//
// Identity-tier endpoints. There is exactly one: `me`. The tenant is the Clerk
// org (project_conventions §6), so there is nothing to switch and no
// membership list to enumerate — the org switcher, if it ever comes back,
// is Clerk's `<OrganizationSwitcher />`, not a local table.
//
// `users` is TABLE_SCOPE type 'none' (the pre-tenant lookup table), so the row
// is fetched with an explicit (id, tenant_id) predicate rather than ctx.db.

import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { router, protectedProcedure } from "../procedures";
import { db } from "../../db/client";
import { users } from "../../../drizzle/schema";

export const usersRouter = router({
  /** The signed-in user's local row, plus the Clerk org they're acting in. */
  me: protectedProcedure.query(async ({ ctx }) => {
    const [row] = await db
      .select({
        userId: users.id,
        openId: users.openId,
        email: users.email,
        name: users.name,
      })
      .from(users)
      .where(and(eq(users.id, ctx.userId), eq(users.tenantId, ctx.tenantId)))
      .limit(1);

    if (!row) {
      throw new TRPCError({ code: "NOT_FOUND", message: "user not found" });
    }

    return {
      userId: row.userId,
      openId: row.openId,
      email: row.email,
      name: row.name,
      tenantId: ctx.tenantId,
      role: ctx.role,
    };
  }),
});
