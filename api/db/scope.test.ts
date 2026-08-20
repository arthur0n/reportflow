// api/db/scope.test.ts
//
// The TABLE_SCOPE safety rail. Four properties matter:
//   1. an unregistered table is a crash, not a silent full-table read
//      (decisions §12.9 — the deliberate deviation from the sharpmoney
//      scaffold, which returned sql`true`);
//   2. a registered tenant table gets `tenant_id = $ctx.tenantId` injected;
//   3. lovConditions splits system / tenant / combined the way
//      project_conventions §6 describes;
//   4. a tenant-scoped table queried/written with no (or empty) tenantId
//      throws instead of degrading to a weaker filter — on both the read
//      side (conditions()) and the write side (assertTenantScoped, which
//      also refuses 'none' tables — writes to `users` must go through
//      explicit dedicated queries, never the scoped write helpers).

import { describe, it, expect } from "vitest";
import { PgDialect, pgTable, uuid, varchar, timestamp } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { createScopedDb, assertTenantScoped, TABLE_SCOPE } from "./scope";
import { auditLogs, listOfValues, tenantValues, users } from "../../drizzle/schema";

const TENANT = "org_2abcTENANT";
const OTHER_TENANT = "org_2xyzOTHER";

// A table that exists in TypeScript but was never added to TABLE_SCOPE —
// exactly the "forgot the registry entry" mistake the rail exists to catch.
const unregistered = pgTable("forgotten_table", {
  id: uuid().defaultRandom().primaryKey().notNull(),
  tenantId: varchar("tenant_id", { length: 64 }).notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "string" }),
});

const dialect = new PgDialect();

/** Render a drizzle SQL fragment to "<sql> :: <params>" for assertions. */
function sqlText(fragment: SQL): string {
  const { sql, params } = dialect.sqlToQuery(fragment);
  return `${sql} :: ${JSON.stringify(params)}`;
}

describe("TABLE_SCOPE registry", () => {
  it("registers every table in drizzle/schema.ts", () => {
    expect(Object.keys(TABLE_SCOPE).sort()).toEqual(
      ["audit_logs", "list_of_values", "tenant_values", "users"].sort(),
    );
  });
});

describe("conditions() on an unregistered table", () => {
  it("throws instead of returning a no-op filter", () => {
    const scope = createScopedDb({ tenantId: TENANT });
    expect(() => scope.conditions(unregistered)).toThrowError(/no entry for table/);
    expect(() => scope.conditions(unregistered)).toThrowError(/forgotten_table/);
  });

  it("throws on the write side too", () => {
    expect(() => {
      assertTenantScoped(unregistered, "create");
    }).toThrowError(/no entry for table/);
  });

  it("throws for a 'lov' table — those go through lovConditions()", () => {
    const scope = createScopedDb({ tenantId: TENANT });
    expect(() => scope.conditions(listOfValues)).toThrowError(/use lovConditions/);
    expect(() => {
      assertTenantScoped(listOfValues, "update");
    }).toThrowError(/LOV-CRUD core/);
  });

  it("throws for a 'none' table (users) — writes must go through dedicated queries", () => {
    expect(() => {
      assertTenantScoped(users, "create");
    }).toThrowError(/registered as 'none'/);
    expect(() => {
      assertTenantScoped(users, "update");
    }).toThrowError(/dedicated query/);
  });
});

describe("conditions() on a registered tenant table", () => {
  it("injects the tenant filter and the soft-delete filter", () => {
    const scope = createScopedDb({ tenantId: TENANT });
    const rendered = sqlText(scope.conditions(tenantValues));
    expect(rendered).toContain(TENANT);
    expect(rendered).toContain("tenant_id");
    expect(rendered).toContain("deleted_at");
    expect(rendered).toContain("is null");
  });

  it("scopes to the caller's tenant, never another one", () => {
    const rendered = sqlText(createScopedDb({ tenantId: TENANT }).conditions(tenantValues));
    expect(rendered).not.toContain(OTHER_TENANT);
  });

  it("drops the soft-delete filter under includeDeleted, keeps the tenant filter", () => {
    const scope = createScopedDb({ tenantId: TENANT, includeDeleted: true });
    const rendered = sqlText(scope.conditions(tenantValues));
    expect(rendered).toContain(TENANT);
    expect(rendered).not.toContain("deleted_at");
  });

  it("omits the soft-delete filter for an append-only table", () => {
    const rendered = sqlText(createScopedDb({ tenantId: TENANT }).conditions(auditLogs));
    expect(rendered).toContain(TENANT);
    expect(rendered).not.toContain("deleted_at");
  });

  it("returns a no-op filter for a 'none' table (the pre-tenant lookup)", () => {
    const rendered = sqlText(createScopedDb({ tenantId: TENANT }).conditions(users));
    expect(rendered).toContain("true");
    expect(rendered).not.toContain(TENANT);
  });
});

describe("conditions() on a tenant table with no tenantId", () => {
  it("throws instead of degrading to a weaker (unscoped) filter — tenantId absent", () => {
    const scope = createScopedDb();
    expect(() => scope.conditions(tenantValues)).toThrowError(/tenantId is required/);
    expect(() => scope.conditions(tenantValues)).toThrowError(/tenant_values/);
  });

  it("throws instead of degrading to a weaker (unscoped) filter — tenantId empty string", () => {
    const scope = createScopedDb({ tenantId: "" });
    expect(() => scope.conditions(tenantValues)).toThrowError(/tenantId is required/);
  });

  it("throws even for an append-only tenant table (audit_logs)", () => {
    const scope = createScopedDb();
    expect(() => scope.conditions(auditLogs)).toThrowError(/tenantId is required/);
  });
});

describe("lovConditions()", () => {
  it("'system' matches only tenant_id IS NULL rows", () => {
    const scope = createScopedDb({ tenantId: TENANT });
    const rendered = sqlText(scope.lovConditions({ type: "BANK_SLUG", mode: "system" }));
    expect(rendered).toContain("BANK_SLUG");
    expect(rendered).toContain("tenant_id");
    expect(rendered).toContain("is null");
    expect(rendered).not.toContain(TENANT);
  });

  it("'system' works without a tenant at all", () => {
    const scope = createScopedDb();
    expect(() => scope.lovConditions({ type: "BANK_SLUG", mode: "system" })).not.toThrow();
  });

  it("'tenant' matches only this org's rows", () => {
    const scope = createScopedDb({ tenantId: TENANT });
    const rendered = sqlText(scope.lovConditions({ type: "CATEGORY", mode: "tenant" }));
    expect(rendered).toContain(TENANT);
    expect(rendered).toContain("CATEGORY");
  });

  it("'combined' matches this org's rows OR system rows", () => {
    const scope = createScopedDb({ tenantId: TENANT });
    const rendered = sqlText(scope.lovConditions({ type: "CATEGORY", mode: "combined" }));
    expect(rendered).toContain(TENANT);
    expect(rendered).toContain("or");
    expect(rendered).toContain("is null");
    expect(rendered).not.toContain(OTHER_TENANT);
  });

  it("defaults to combined mode", () => {
    const scope = createScopedDb({ tenantId: TENANT });
    expect(sqlText(scope.lovConditions({ type: "CATEGORY" }))).toEqual(
      sqlText(scope.lovConditions({ type: "CATEGORY", mode: "combined" })),
    );
  });

  it("applies the soft-delete filter unless includeDeleted is set", () => {
    const scope = createScopedDb({ tenantId: TENANT });
    expect(sqlText(scope.lovConditions({ type: "CATEGORY" }))).toContain("deleted_at");
    expect(sqlText(scope.lovConditions({ type: "CATEGORY", includeDeleted: true }))).not.toContain(
      "deleted_at",
    );
  });

  it("refuses tenant/combined reads without a tenant", () => {
    const scope = createScopedDb();
    expect(() => scope.lovConditions({ type: "CATEGORY", mode: "tenant" })).toThrowError(
      /tenantId required/,
    );
    expect(() => scope.lovConditions({ type: "CATEGORY", mode: "combined" })).toThrowError(
      /tenantId required/,
    );
  });
});

describe("withTenant()", () => {
  it("injects the tenant id on insert payloads", () => {
    const scope = createScopedDb({ tenantId: TENANT });
    expect(scope.withTenant({ kind: "SUPPLIER" })).toEqual({
      kind: "SUPPLIER",
      tenantId: TENANT,
    });
  });

  it("refuses to build an unscoped payload", () => {
    expect(() => createScopedDb().withTenant({ kind: "SUPPLIER" })).toThrowError(
      /tenantId required/,
    );
  });
});
