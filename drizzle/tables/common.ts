// drizzle/tables/common.ts
//
// Shared column facts for every scoped table. `tenant_id` is a Clerk org_id
// (conventions §6) — an opaque string like `org_2abc…`, so `varchar(64)`,
// never `uuid`, and never a foreign key to a local `tenants` table (there
// isn't one).

/** Clerk org id column length. One definition, reused by every scoped table. */
export const TENANT_ID_LENGTH = 64;
