// api/trpc/context.ts
//
// Single source of truth for how an incoming request becomes a tRPC context.
//
// Model (project_conventions §6/§7): the tenant IS the Clerk organization.
// There is no local `tenants` table and no `memberships` table.
//   tenant_id — the `org_id` claim on the verified JWT (varchar(64)).
//   users     — one row per (open_id, tenant_id); `role` is OUR authorization
//               layer, not Clerk's. Rows are provisioned manually
//               (scripts/make-admin.ts or plain SQL) — no row, no access.
//
// Per-request resolution:
//   1. Verify the JWT via authProvider (offline, no network call).
//   2. Read `sub` (Clerk user id) and `org_id` (the tenant) from the payload.
//   3. Look up the local users row by (open_id, tenant_id) — one indexed hit.
//      No row → treat as unauthorized: authenticated in Clerk, not provisioned
//      here yet.
//
// Routers consume ctx.db (built by protectedProcedure) — they do not query
// with the raw handle. See api/db/scoped-client.ts.

import type { CreateAWSLambdaContextOptions } from "@trpc/server/adapters/aws-lambda";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { users } from "../../drizzle/schema";
import { authProvider } from "../lib/auth-provider";

/** Authorization roles. Stored on users.role; never read from the JWT. */
export const ROLES = ["platform_admin", "admin", "member"] as const;
export type Role = (typeof ROLES)[number];

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export type Context = {
  /** Clerk org_id from the JWT. Null when the token is absent/invalid/org-less. */
  tenantId: string | null;
  /** Local users.id (uuid). Null when there is no provisioned row. */
  userId: string | null;
  /** From users.role. Null whenever userId is null. */
  role: Role | null;
};

type FlatHeaders = Record<string, string | undefined>;

const EMPTY: Context = { tenantId: null, userId: null, role: null };

async function createContextFromHeaders(headers: FlatHeaders): Promise<Context> {
  const auth = headers["authorization"];
  if (auth?.startsWith("Bearer ") !== true) {
    return EMPTY;
  }

  try {
    const verified = await authProvider.verifyToken(auth.slice(7));
    const openId = verified.sub;
    const orgId = verified.orgId;

    if (openId.length === 0) {
      console.warn("[auth] JWT missing sub claim");
      return EMPTY;
    }
    if (orgId === undefined || orgId.length === 0) {
      // Signed in but not a member of any org — nothing to scope to.
      // The frontend surfaces "peça um convite" for this case.
      console.warn("[auth] JWT missing org_id claim");
      return EMPTY;
    }

    // Composite identity (open_id, tenant_id): the same Clerk user can belong
    // to more than one org with a different role in each.
    const [row] = await db
      .select({ userId: users.id, role: users.role })
      .from(users)
      .where(and(eq(users.openId, openId), eq(users.tenantId, orgId)))
      .limit(1);

    if (!row) {
      // Authenticated in Clerk, but not provisioned in our DB. Unauthorized
      // until someone INSERTs the row with the correct role.
      console.warn("[auth] no local users row for this (open_id, org_id)");
      return EMPTY;
    }

    return {
      tenantId: orgId,
      userId: row.userId,
      role: isRole(row.role) ? row.role : "member",
    };
  } catch (err) {
    console.error("[auth] JWT verification failed", err);
    return EMPTY;
  }
}

function normalizeHeaders(raw: Record<string, string | string[] | undefined>): FlatHeaders {
  const out: FlatHeaders = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
  }
  return out;
}

export async function createContext({
  event,
}: CreateAWSLambdaContextOptions<APIGatewayProxyEventV2>): Promise<Context> {
  return createContextFromHeaders(event.headers);
}

export async function createExpressContext({
  req,
}: {
  req: { headers: Record<string, string | string[] | undefined> };
}): Promise<Context> {
  return createContextFromHeaders(normalizeHeaders(req.headers));
}
