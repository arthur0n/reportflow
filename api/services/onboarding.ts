// api/services/onboarding.ts
//
// Tenant bootstrap orchestrator. Two entry points:
//
//   selfServiceCreateTenant — called from onboarding.createTenant after the
//     user has signed up + verified their email via the provider's frontend
//     SDK. The provider already has a verified user; we own creating the org
//     mirror, the tenant row, and the admin membership.
//
//   staffCreateCustomer — called from onboarding.createCustomer (admin tier).
//     Drives the provider all the way: createUser → createOrganization →
//     DB rows → password-setup ticket. Caller hands the ticket URL to the
//     new admin out-of-band.
//
// Both paths share the same DB transaction (inserts/updates of tenants,
// users, memberships + audit). All inserts are idempotent on external_id;
// if a webhook from the provider arrives mid-orchestration the same rows
// are upserted defensively.
//
// adminDb is used here (not a scoped client) because we are creating the
// tenant the user will later be scoped to. This file plus
// api/routes/webhook-routes.ts are the only sanctioned consumers of adminDb.
//
// Failure model: provider calls happen first. If a DB step fails after a
// provider call succeeded, the orphan provider rows are reconciled by the
// existing webhook handler the next time the provider redelivers
// organization.created / organizationMembership.created.

import { eq, sql } from "drizzle-orm";
import { adminDb } from "../db/admin-client";
import { memberships, tenants, users } from "../../drizzle/schema";
import { authProvider } from "../lib/auth-provider";
import { writeAuditEntry } from "./audit";
import { MEMBERSHIP_RANK } from "../../shared/constants/membership-roles";

type SelfServiceInput = {
  externalUserId: string;
  email: string | null;
  name: string | null;
  businessName: string;
  industry: string;
};

type StaffInput = {
  email: string;
  firstName: string;
  lastName: string;
  businessName: string;
  industry: string;
};

export type SelfServiceResult = {
  tenantId: string;
  userId: string;
};

export type StaffResult = {
  tenantId: string;
  userId: string;
  externalUserId: string;
  inviteUrl: string;
  inviteExpiresAt: Date;
};

async function findOrCreateUserRow(
  externalUserId: string,
  email: string | null,
  name: string | null,
): Promise<string> {
  const [existing] = await adminDb
    .select({ id: users.id })
    .from(users)
    .where(eq(users.externalId, externalUserId))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await adminDb
    .insert(users)
    .values({ externalId: externalUserId, email, name })
    .onConflictDoNothing()
    .returning({ id: users.id });
  if (created) return created.id;

  const [raced] = await adminDb
    .select({ id: users.id })
    .from(users)
    .where(eq(users.externalId, externalUserId))
    .limit(1);
  if (!raced) {
    throw new Error(`[onboarding] user creation failed for ${externalUserId}`);
  }
  return raced.id;
}

/**
 * Insert the tenant + membership + audit rows and pin users.activeTenantId.
 * Assumes the users row already exists (caller has resolved internalUserId).
 * Idempotent on (tenant.external_id) and (membership user_id, tenant_id).
 */
async function insertTenantAndMembership(args: {
  internalUserId: string;
  externalOrgId: string;
  businessName: string;
  industry: string;
}): Promise<{ tenantId: string }> {
  const { internalUserId, externalOrgId, businessName, industry } = args;

  return adminDb.transaction(async (tx) => {
    let [tenantRow] = await tx
      .insert(tenants)
      .values({
        externalId: externalOrgId,
        name: businessName,
        industry,
        createdBy: internalUserId,
        lastUpdBy: internalUserId,
      })
      .onConflictDoNothing()
      .returning({ id: tenants.id });

    if (!tenantRow) {
      const [existing] = await tx
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.externalId, externalOrgId))
        .limit(1);
      if (!existing) {
        throw new Error(`[onboarding] tenant insert failed for ${externalOrgId}`);
      }
      tenantRow = existing;
    }

    const tenantId = tenantRow.id;

    await tx
      .update(users)
      .set({
        activeTenantId: tenantId,
        lastUpdAt: new Date().toISOString(),
        lastUpdBy: internalUserId,
      })
      .where(eq(users.id, internalUserId));

    const [membershipRow] = await tx
      .insert(memberships)
      .values({
        userId: internalUserId,
        tenantId,
        role: MEMBERSHIP_RANK.ADMIN,
        joinedAt: sql`now()`,
        invitedBy: null,
        createdBy: internalUserId,
        lastUpdBy: internalUserId,
      })
      .onConflictDoNothing()
      .returning({ id: memberships.id });

    if (membershipRow) {
      await writeAuditEntry({
        ctx: { tenantId, userId: internalUserId },
        entityType: "TENANT",
        entityId: tenantId,
        action: "create",
        after: { name: businessName, industry, externalId: externalOrgId },
        tx,
      });
      await writeAuditEntry({
        ctx: { tenantId, userId: internalUserId },
        entityType: "MEMBERSHIP",
        entityId: membershipRow.id,
        action: "create",
        after: {
          userId: internalUserId,
          tenantId,
          role: MEMBERSHIP_RANK.ADMIN,
        },
        tx,
      });
    }

    return { tenantId };
  });
}

export async function selfServiceCreateTenant(input: SelfServiceInput): Promise<SelfServiceResult> {
  const internalUserId = await findOrCreateUserRow(input.externalUserId, input.email, input.name);

  const { externalId: externalOrgId } = await authProvider.createOrganization({
    name: input.businessName,
    ownerExternalId: input.externalUserId,
  });

  const { tenantId } = await insertTenantAndMembership({
    internalUserId,
    externalOrgId,
    businessName: input.businessName,
    industry: input.industry,
  });

  return { tenantId, userId: internalUserId };
}

export async function staffCreateCustomer(input: StaffInput): Promise<StaffResult> {
  const fullName = `${input.firstName} ${input.lastName}`.trim();

  const { externalId: externalUserId } = await authProvider.createUser({
    email: input.email,
    name: fullName,
  });

  const internalUserId = await findOrCreateUserRow(externalUserId, input.email, fullName);

  const { externalId: externalOrgId } = await authProvider.createOrganization({
    name: input.businessName,
    ownerExternalId: externalUserId,
  });

  const { tenantId } = await insertTenantAndMembership({
    internalUserId,
    externalOrgId,
    businessName: input.businessName,
    industry: input.industry,
  });

  const ticket = await authProvider.createPasswordSetupTicket({ externalUserId });

  return {
    tenantId,
    userId: internalUserId,
    externalUserId,
    inviteUrl: ticket.url,
    inviteExpiresAt: ticket.expiresAt,
  };
}
