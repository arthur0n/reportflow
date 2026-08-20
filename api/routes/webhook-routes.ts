// api/routes/webhook-routes.ts
//
// Auth provider webhook handlers. This is the ONLY place where rows in the
// `tenants` and `users` tables are created — every other code path assumes
// the rows already exist (see api/trpc/context.ts).
//
// The auth provider is an adapter. Types and names are provider-agnostic.
// Signature verification uses Svix (the provider's webhook signing library).

import { Webhook } from "svix";
import { eq, sql } from "drizzle-orm";
import { adminDb } from "../db/admin-client";
import { memberships, tenants, users } from "../../drizzle/schema";
import { MEMBERSHIP_RANK } from "../../shared/constants/membership-roles";

type LambdaResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

function ok(body: unknown): LambdaResponse {
  return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(body) };
}
function bad(status: number, message: string): LambdaResponse {
  return { statusCode: status, headers: JSON_HEADERS, body: JSON.stringify({ error: message }) };
}

// Webhook payload types — provider-agnostic names.

type ExternalUserEvent = {
  type: "user.created" | "user.updated" | "user.deleted";
  data: {
    id: string;
    email_addresses?: Array<{ email_address: string }>;
    first_name?: string | null;
    last_name?: string | null;
    deleted?: boolean;
    organization_memberships?: Array<{
      organization: { id: string };
    }>;
  };
};

type ExternalOrgMembershipEvent = {
  type: "organizationMembership.created";
  data: {
    id: string;
    organization: { id: string };
    public_user_data: {
      user_id: string;
      first_name?: string | null;
      last_name?: string | null;
      identifier?: string;
    };
    role: string;
  };
};

type ExternalOrgEvent = {
  type: "organization.created" | "organization.updated" | "organization.deleted";
  data: {
    id: string;
    name: string;
  };
};

type ExternalWebhookEvent = ExternalUserEvent | ExternalOrgMembershipEvent | ExternalOrgEvent;

function fullName(
  first: string | null | undefined,
  last: string | null | undefined,
): string | null {
  const parts = [first, last].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Resolve our internal tenant id from the auth provider's org id, creating
 * the row defensively if the membership event arrives before
 * organization.created. Domain seed data (categories, payment methods) is
 * served at runtime via the combined-mode LOV read — no per-tenant clones.
 */
async function findOrCreateTenant(externalOrgId: string, name?: string): Promise<string> {
  const [existing] = await adminDb
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.externalId, externalOrgId))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await adminDb
    .insert(tenants)
    .values({ externalId: externalOrgId, name: name ?? externalOrgId })
    .onConflictDoNothing()
    .returning({ id: tenants.id });
  if (created) return created.id;

  const [raced] = await adminDb
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.externalId, externalOrgId))
    .limit(1);
  if (!raced) throw new Error(`[webhook] tenant creation failed for ${externalOrgId}`);
  return raced.id;
}

async function handleOrgCreated(data: ExternalOrgEvent["data"]): Promise<void> {
  await findOrCreateTenant(data.id, data.name);
}

async function handleOrgDeleted(data: ExternalOrgEvent["data"]): Promise<void> {
  await adminDb
    .update(tenants)
    .set({ deletedAt: new Date().toISOString() })
    .where(eq(tenants.externalId, data.id));
}

async function handleOrgUpdated(data: ExternalOrgEvent["data"]): Promise<void> {
  await adminDb
    .update(tenants)
    .set({
      name: data.name,
      lastUpdAt: new Date().toISOString(),
    })
    .where(eq(tenants.externalId, data.id));
}

async function handleUserCreated(data: ExternalUserEvent["data"]): Promise<void> {
  const email = data.email_addresses?.[0]?.email_address ?? null;
  const name = fullName(data.first_name, data.last_name);
  await adminDb.insert(users).values({ externalId: data.id, email, name }).onConflictDoNothing();
}

async function handleOrgMembershipCreated(data: ExternalOrgMembershipEvent["data"]): Promise<void> {
  const externalOrgId = data.organization.id;
  const externalUserId = data.public_user_data.user_id;
  const email = data.public_user_data.identifier ?? null;
  const name = fullName(data.public_user_data.first_name, data.public_user_data.last_name);

  const tenantId = await findOrCreateTenant(externalOrgId);

  const [user] = await adminDb
    .insert(users)
    .values({ externalId: externalUserId, email, name })
    .onConflictDoUpdate({
      target: users.externalId,
      set: { email, name },
    })
    .returning({ id: users.id, activeTenantId: users.activeTenantId });
  if (!user) throw new Error(`[webhook] user upsert failed for ${externalUserId}`);

  await adminDb
    .insert(memberships)
    .values({
      userId: user.id,
      tenantId,
      role: MEMBERSHIP_RANK.ADMIN,
      joinedAt: sql`now()`,
      invitedBy: null,
      createdBy: user.id,
      lastUpdBy: user.id,
    })
    .onConflictDoNothing();

  if (user.activeTenantId === null) {
    await adminDb
      .update(users)
      .set({
        activeTenantId: tenantId,
        lastUpdAt: new Date().toISOString(),
        lastUpdBy: user.id,
      })
      .where(eq(users.id, user.id));
  }
}

async function handleUserUpdated(data: ExternalUserEvent["data"]): Promise<void> {
  const email = data.email_addresses?.[0]?.email_address ?? null;
  const name = fullName(data.first_name, data.last_name);
  await adminDb
    .update(users)
    .set({ email, name, lastUpdAt: new Date().toISOString() })
    .where(eq(users.externalId, data.id));
}

async function handleUserDeleted(data: ExternalUserEvent["data"]): Promise<void> {
  await adminDb.delete(users).where(eq(users.externalId, data.id));
}

async function dispatchWebhookEvent(evt: ExternalWebhookEvent): Promise<void> {
  switch (evt.type) {
    case "organization.created":
      return handleOrgCreated(evt.data);
    case "organization.updated":
      return handleOrgUpdated(evt.data);
    case "organization.deleted":
      return handleOrgDeleted(evt.data);
    case "organizationMembership.created":
      return handleOrgMembershipCreated(evt.data);
    case "user.created":
      return handleUserCreated(evt.data);
    case "user.updated":
      return handleUserUpdated(evt.data);
    case "user.deleted":
      return handleUserDeleted(evt.data);
  }
}

/**
 * Route dispatcher. Called from api/handler.ts before the tRPC adapter.
 * Returns a LambdaResponse if the path matched a webhook route, or null if
 * the request should fall through to tRPC.
 */
export async function handleWebhookRoutes(
  method: string,
  path: string,
  body: string,
  headers: Record<string, string | undefined>,
): Promise<LambdaResponse | null> {
  if (method !== "POST" || path !== "/webhooks/clerk") {
    return null;
  }

  const secret = process.env["CLERK_WEBHOOK_SECRET"];
  if (secret === undefined || secret.length === 0) {
    return bad(500, "CLERK_WEBHOOK_SECRET not configured");
  }

  const svixHeaders = {
    "svix-id": headers["svix-id"] ?? "",
    "svix-timestamp": headers["svix-timestamp"] ?? "",
    "svix-signature": headers["svix-signature"] ?? "",
  };

  let evt: ExternalWebhookEvent;
  try {
    evt = new Webhook(secret).verify(body, svixHeaders) as ExternalWebhookEvent;
  } catch (err) {
    console.error("[webhook] signature verification failed", err);
    return bad(401, "invalid signature");
  }

  try {
    await dispatchWebhookEvent(evt);
    return ok({ received: true, type: evt.type });
  } catch (err) {
    console.error("[webhook] handler failed", err);
    return bad(500, "handler error");
  }
}
