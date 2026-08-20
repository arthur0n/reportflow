// scripts/make-admin.ts
//
// Sets users.role for one (email, org) pair. Ported from lexflow — but lexflow
// is B2C with no tenants, so it keys on the Clerk user id alone. Here identity
// is the composite (open_id, tenant_id), and the tenant is a Clerk org id, so
// the org is a required argument: never promote "the user with this email"
// across every org they happen to belong to.
//
//   pnpm db:make-admin <email> <org_id> [role]
//
// role defaults to 'admin'; 'platform_admin' and 'member' are also accepted
// ('member' demotes). Script context — a direct pool, not a request context,
// so there is no ctx.db to route through.
//
// This is deliberately manual (project_conventions §7): role changes should
// never be automatic.

import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { and, eq } from "drizzle-orm";
import { users } from "../drizzle/schema";

const ROLES = ["platform_admin", "admin", "member"] as const;
type Role = (typeof ROLES)[number];

function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

function usage(): never {
  console.error("usage: pnpm db:make-admin <email> <org_id> [platform_admin|admin|member]");
  process.exit(1);
}

async function main(): Promise<void> {
  const [email, orgId, roleArg = "admin"] = process.argv.slice(2);
  if (email === undefined || email.length === 0) usage();
  if (orgId === undefined || orgId.length === 0) usage();
  if (!isRole(roleArg)) usage();

  const connectionString =
    process.env["DATABASE_URL"] ??
    `postgresql://${process.env["DB_USER"]}:${process.env["DB_PASSWORD"]}@${process.env["DB_HOST"]}/${process.env["DB_NAME"]}`;
  const pool = new Pool({ connectionString, ssl: { rejectUnauthorized: false }, max: 1 });

  try {
    const db = drizzle(pool);

    // Look up the match set FIRST. (email, tenant_id) carries no unique
    // constraint at the DB level, so a single UPDATE with this WHERE could
    // silently touch more than one row. Abort instead of ever risking that.
    const matches = await db
      .select({ id: users.id, openId: users.openId, role: users.role })
      .from(users)
      .where(and(eq(users.email, email), eq(users.tenantId, orgId)));

    if (matches.length === 0) {
      console.error(`[make-admin] ✗ no users row for email=${email} tenant_id=${orgId}`);
      console.error("  Provision the row first — see project_conventions §7.");
      process.exit(1);
    }

    if (matches.length > 1) {
      console.error(
        `[make-admin] ✗ ${matches.length} users rows match email=${email} tenant_id=${orgId} — refusing to update more than one row:`,
      );
      for (const row of matches) {
        console.error(`  users.id=${row.id} open_id=${row.openId} role=${row.role}`);
      }
      console.error("  Resolve the duplicate (by id) before retrying.");
      process.exit(1);
    }

    const target = matches[0];
    if (target === undefined) {
      throw new Error("unreachable: matches.length === 1 but matches[0] is undefined");
    }

    const [updated] = await db
      .update(users)
      .set({ role: roleArg, lastUpdAt: new Date().toISOString() })
      .where(eq(users.id, target.id))
      .returning({ id: users.id, openId: users.openId, role: users.role });
    if (!updated) {
      throw new Error(`update by id=${target.id} affected no row (race?)`);
    }

    console.warn(
      `[make-admin] ✓ users.id=${updated.id} open_id=${updated.openId} tenant_id=${orgId} role=${updated.role}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error("[make-admin] ✗ failed:", err);
  process.exit(1);
});
