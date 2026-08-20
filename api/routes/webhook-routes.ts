// api/routes/webhook-routes.ts
//
// Auth-provider webhook handler. DORMANT during the foundation phase
// (decisions §9, project_conventions §7): users are provisioned by hand, so
// nothing depends on this route being wired up. It stays here, signature
// verification and all, so enabling it later is a dashboard change plus an
// SSM parameter — not a code archaeology exercise.
//
// Users are provisioned manually ONLY (project_conventions §7, decisions §2)
// — scripts/make-admin.ts or plain SQL. The webhook MUST NOT create `users`
// rows, ever, including on `organizationMembership.created`: that event is
// acknowledged and logged only, never used to insert a row. Automatic
// provisioning from a webhook payload would let anyone Clerk lets into an org
// mint themselves a local row outside the manual review step.
//
// Revocation is the exception: removing access is always safe, so
// `organizationMembership.deleted` still deletes the local row for that
// (open_id, tenant_id), and `user.deleted` still removes the user everywhere.
// `user.updated` still syncs profile fields on existing rows. None of these
// paths ever INSERTs.

import { Webhook } from "svix";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { users } from "../../drizzle/schema";

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
  };
};

type ExternalOrgMembershipEvent = {
  type: "organizationMembership.created" | "organizationMembership.deleted";
  data: {
    id: string;
    organization: { id: string };
    public_user_data: {
      user_id: string;
      first_name?: string | null;
      last_name?: string | null;
      identifier?: string;
    };
  };
};

type ExternalWebhookEvent = ExternalUserEvent | ExternalOrgMembershipEvent;

function fullName(
  first: string | null | undefined,
  last: string | null | undefined,
): string | null {
  const parts = [first, last].filter((p): p is string => Boolean(p));
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Users are provisioned manually — never from a webhook (project_conventions
 * §7, decisions §2). Ack + log only; no row is written. If this membership
 * should have local access, provision it by hand (scripts/make-admin.ts or
 * plain SQL) after reviewing it.
 */
function handleOrgMembershipCreated(data: ExternalOrgMembershipEvent["data"]): void {
  console.warn(
    "[webhook] organizationMembership.created received — provisioning is manual, no row created",
    { userId: data.public_user_data.user_id, tenantId: data.organization.id },
  );
}

/** Membership revoked in Clerk → the row for THAT org goes; others survive. */
async function handleOrgMembershipDeleted(data: ExternalOrgMembershipEvent["data"]): Promise<void> {
  await db
    .delete(users)
    .where(
      and(
        eq(users.openId, data.public_user_data.user_id),
        eq(users.tenantId, data.organization.id),
      ),
    );
}

/** Profile change — applies to every org row this Clerk user has. */
async function handleUserUpdated(data: ExternalUserEvent["data"]): Promise<void> {
  await db
    .update(users)
    .set({
      email: data.email_addresses?.[0]?.email_address ?? null,
      name: fullName(data.first_name, data.last_name),
      lastUpdAt: new Date().toISOString(),
    })
    .where(eq(users.openId, data.id));
}

/** User deleted in Clerk → they lose access everywhere. */
async function handleUserDeleted(data: ExternalUserEvent["data"]): Promise<void> {
  await db.delete(users).where(eq(users.openId, data.id));
}

async function dispatchWebhookEvent(evt: ExternalWebhookEvent): Promise<void> {
  switch (evt.type) {
    case "organizationMembership.created":
      handleOrgMembershipCreated(evt.data);
      return;
    case "organizationMembership.deleted":
      return handleOrgMembershipDeleted(evt.data);
    case "user.updated":
      return handleUserUpdated(evt.data);
    case "user.deleted":
      return handleUserDeleted(evt.data);
    case "user.created":
      // Users are provisioned manually (project_conventions §7) — nothing to
      // write here, on this event or on the membership event that follows it.
      return;
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
