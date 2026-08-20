// api/trpc/context.ts
//
// Single source of truth for how an incoming request becomes a tRPC context.
//
// Model (we own this; the auth provider is just an identity adapter):
//   tenants     — orgs. tenants.external_id holds the auth provider's org id.
//   users       — people. users.external_id holds the auth provider's user id.
//                 users.active_tenant_id is the tenant the user is currently
//                 acting in (Salesforce model).
//   memberships — per-tenant grants. (user_id, tenant_id, role) plus lifecycle
//                 (joined_at / expires_at / deleted_at).
//
// Per-request resolution:
//   1. Verify the JWT via authProvider (offline, no network call).
//   2. Look up the local users row by external_id, LEFT JOIN active membership
//      (joined, non-expired, non-revoked) for users.active_tenant_id, LEFT
//      JOIN tenants for industry.
//   3. ctx.userId is always set when authenticated.
//      ctx.tenantId / tenantIndustry / role are set iff there's an active
//      membership for the active_tenant_id.
//      ctx.role is the active membership's numeric rank.
//
// Routers consume ctx.db (built by protectedProcedure) — they do not read
// ctx.tenantId directly. See api/db/scoped-client.ts.

import type { CreateAWSLambdaContextOptions } from "@trpc/server/adapters/aws-lambda";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { and, eq, gt, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "../db/client";
import { memberships, tenants, users } from "../../drizzle/schema";
import { authProvider } from "../lib/auth-provider";

export type Context = {
  // Provider's user id from the verified JWT. Set whenever the bearer token is
  // valid, even when no local `users` row exists yet (e.g. signup race window
  // before the user.created webhook lands). Onboarding's createTenant relies
  // on this to bootstrap the row inline.
  externalUserId: string | null;
  userId: string | null;
  tenantId: string | null;
  tenantIndustry: string | null;
  role: number | null;
};

type FlatHeaders = Record<string, string | undefined>;

const EMPTY: Context = {
  externalUserId: null,
  userId: null,
  tenantId: null,
  tenantIndustry: null,
  role: null,
};

async function createContextFromHeaders(headers: FlatHeaders): Promise<Context> {
  const auth = headers["authorization"];
  if (auth?.startsWith("Bearer ") !== true) {
    return EMPTY;
  }

  try {
    const verified = await authProvider.verifyToken(auth.slice(7));
    const externalUserId = verified.sub;

    if (externalUserId.length === 0) {
      console.warn("[auth] JWT missing sub claim");
      return EMPTY;
    }

    const [row] = await db
      .select({
        userId: users.id,
        activeTenantId: users.activeTenantId,
        role: memberships.role,
        tenantIndustry: tenants.industry,
      })
      .from(users)
      .leftJoin(
        memberships,
        and(
          eq(memberships.userId, users.id),
          eq(memberships.tenantId, users.activeTenantId),
          isNull(memberships.deletedAt),
          isNotNull(memberships.joinedAt),
          or(isNull(memberships.expiresAt), gt(memberships.expiresAt, sql`now()`)),
        ),
      )
      .leftJoin(tenants, eq(tenants.id, users.activeTenantId))
      .where(eq(users.externalId, externalUserId))
      .limit(1);

    if (!row) {
      // Valid token but no local user row yet — happens during the signup
      // race window before the user.created webhook arrives. Onboarding's
      // createTenant uses externalUserId to bootstrap the row inline.
      return { ...EMPTY, externalUserId };
    }

    return {
      externalUserId,
      userId: row.userId,
      tenantId: row.activeTenantId,
      tenantIndustry: row.tenantIndustry,
      role: row.role,
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
