// api/db/outbound-access.test.ts
//
// assertVersionVisible is the ONLY thing standing between "pin any version
// by id" and a cross-tenant read of another org's template content — the
// version row itself carries no tenant_id (drizzle/tables/outbound.ts).
// Covers both directions: visible (own tenant + system) and invisible
// (another tenant's private template).

import { describe, it, expect, vi } from "vitest";
import { assertVersionVisible, type DbLike } from "./outbound-access";

const TENANT = "org_2abcTENANT";
const OTHER_TENANT = "org_2xyzOTHER";

function makeFakeDb(rows: { templateTenantId: string | null }[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const innerJoin = vi.fn().mockReturnValue({ where });
  const from = vi.fn().mockReturnValue({ innerJoin });
  const select = vi.fn().mockReturnValue({ from });
  return { select, from, innerJoin, where, limit };
}

describe("assertVersionVisible", () => {
  it("does not throw when the version's parent template belongs to the caller's own tenant", async () => {
    const fakeDb = makeFakeDb([{ templateTenantId: TENANT }]);
    await expect(
      assertVersionVisible(fakeDb as unknown as DbLike, "version-1", TENANT),
    ).resolves.toBeUndefined();
  });

  it("does not throw when the version's parent template is a SYSTEM template", async () => {
    const fakeDb = makeFakeDb([{ templateTenantId: null }]);
    await expect(
      assertVersionVisible(fakeDb as unknown as DbLike, "version-1", TENANT),
    ).resolves.toBeUndefined();
  });

  it("throws when the version's parent template belongs to another tenant", async () => {
    const fakeDb = makeFakeDb([{ templateTenantId: OTHER_TENANT }]);
    await expect(
      assertVersionVisible(fakeDb as unknown as DbLike, "version-1", TENANT),
    ).rejects.toThrowError(/outside tenant/);
  });

  it("throws when the version does not exist at all", async () => {
    const fakeDb = makeFakeDb([]);
    await expect(
      assertVersionVisible(fakeDb as unknown as DbLike, "missing-version", TENANT),
    ).rejects.toThrowError(/does not exist/);
  });
});
