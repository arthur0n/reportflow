// api/lib/auth-provider/clerk.ts
//
// Clerk implementation of AuthProvider.
//
// Read side — verifyToken — is offline (no network round-trip per request)
// using CLERK_JWT_KEY (PEM public key from Clerk Dashboard → API Keys).
//
// Write side — createUser / createOrganization / createPasswordSetupTicket —
// uses the Clerk Backend API via @clerk/backend's createClerkClient with
// CLERK_SECRET_KEY. Self-service signup does NOT go through createUser; it
// uses the provider's frontend SDK so email verification + future MFA stay
// in Clerk's hands. createUser exists only for the staff-created flow.

import { createClerkClient, verifyToken } from "@clerk/backend";
import type {
  AuthProvider,
  CreateOrganizationInput,
  CreatePasswordSetupTicketInput,
  CreatedPasswordSetupTicket,
  CreateUserInput,
  VerifiedToken,
} from "./types";

const PASSWORD_SETUP_TICKET_TTL_SECONDS = 60 * 60 * 24 * 7;

let cachedClient: ReturnType<typeof createClerkClient> | null = null;
function getClient(): ReturnType<typeof createClerkClient> {
  if (cachedClient !== null) return cachedClient;
  const secretKey = process.env["CLERK_SECRET_KEY"];
  if (secretKey === undefined || secretKey.length === 0) {
    throw new Error("CLERK_SECRET_KEY is not set");
  }
  cachedClient = createClerkClient({ secretKey });
  return cachedClient;
}

function getAppUrl(): string {
  const url = process.env["APP_URL"];
  if (url === undefined || url.length === 0) {
    throw new Error("APP_URL is not set (needed to build password-setup ticket URLs)");
  }
  return url.replace(/\/+$/, "");
}

function splitName(name: string | null | undefined): {
  firstName?: string;
  lastName?: string;
} {
  const trimmed = (name ?? "").trim();
  if (trimmed.length === 0) return {};
  const parts = trimmed.split(/\s+/);
  const [first, ...rest] = parts;
  const result: { firstName?: string; lastName?: string } = {};
  if (first !== undefined) result.firstName = first;
  if (rest.length > 0) result.lastName = rest.join(" ");
  return result;
}

export const clerkAuthProvider: AuthProvider = {
  async verifyToken(token: string): Promise<VerifiedToken> {
    const jwtKey = process.env["CLERK_JWT_KEY"];
    if (jwtKey === undefined || jwtKey.length === 0) {
      throw new Error("CLERK_JWT_KEY is not set");
    }
    const payload = await verifyToken(token, { jwtKey });
    const orgId = payload["org_id"];
    return typeof orgId === "string" && orgId.length > 0
      ? { sub: payload.sub, orgId }
      : { sub: payload.sub };
  },

  async createUser(input: CreateUserInput): Promise<{ externalId: string }> {
    const created = await getClient().users.createUser({
      emailAddress: [input.email],
      ...splitName(input.name),
      skipPasswordRequirement: true,
    });
    return { externalId: created.id };
  },

  async createOrganization(input: CreateOrganizationInput): Promise<{ externalId: string }> {
    const created = await getClient().organizations.createOrganization({
      name: input.name,
      createdBy: input.ownerExternalId,
    });
    return { externalId: created.id };
  },

  async createPasswordSetupTicket(
    input: CreatePasswordSetupTicketInput,
  ): Promise<CreatedPasswordSetupTicket> {
    const ticket = await getClient().signInTokens.createSignInToken({
      userId: input.externalUserId,
      expiresInSeconds: PASSWORD_SETUP_TICKET_TTL_SECONDS,
    });
    const url = `${getAppUrl()}/sign-in?__clerk_ticket=${ticket.token}`;
    const expiresAt = new Date(Date.now() + PASSWORD_SETUP_TICKET_TTL_SECONDS * 1000);
    return { url, expiresAt };
  },
};
