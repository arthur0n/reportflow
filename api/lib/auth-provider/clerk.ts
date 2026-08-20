// api/lib/auth-provider/clerk.ts
//
// Clerk implementation of AuthProvider.
//
// verifyToken is offline (no network round-trip per request) using
// CLERK_JWT_KEY — the PEM public key from Clerk Dashboard → API Keys → Show
// JWT public key. That is what lets the Lambda run inside the VPC, where there
// is no internet.
//
// authorizedParties pins verification to the origin(s) the frontend is
// actually served from (the JWT's `azp` claim) — without it, a token minted
// for a different site would still verify. APP_ORIGINS is a comma-separated
// list of allowed origins; unset falls back to the local Vite dev origin.
//
// The `org_id` claim comes from the Clerk JWT template (project_conventions
// §7): `{ "org_id": "{{org.id}}", "org_slug": "{{org.slug}}" }`. We
// deliberately do NOT read any role claim — roles live in users.role.

import { verifyToken } from "@clerk/backend";
import type { AuthProvider, VerifiedToken } from "./types";

// Sane default for local dev only (Vite's default port). Prod/staging MUST
// set APP_ORIGINS explicitly via SSM — see clerk-prod-setup.
const DEFAULT_APP_ORIGINS = "http://localhost:5173";

function resolveAuthorizedParties(): string[] {
  const raw = process.env["APP_ORIGINS"];
  const source = raw !== undefined && raw.trim().length > 0 ? raw : DEFAULT_APP_ORIGINS;
  return source
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export const clerkAuthProvider: AuthProvider = {
  async verifyToken(token: string): Promise<VerifiedToken> {
    const jwtKey = process.env["CLERK_JWT_KEY"];
    if (jwtKey === undefined || jwtKey.length === 0) {
      throw new Error("CLERK_JWT_KEY is not set");
    }
    const payload = await verifyToken(token, {
      jwtKey,
      authorizedParties: resolveAuthorizedParties(),
    });
    const orgId = payload["org_id"];
    return typeof orgId === "string" && orgId.length > 0
      ? { sub: payload.sub, orgId }
      : { sub: payload.sub };
  },
};
