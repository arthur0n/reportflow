// api/db/outbound-access.test.ts
//
// assertVersionVisible is the ONLY thing standing between "pin any version
// by id" and a cross-tenant read of another org's template content — the
// version row itself carries no tenant_id (drizzle/tables/outbound.ts).
// Covers both directions: visible (own tenant + system) and invisible
// (another tenant's private template).

import { describe, it, expect, vi } from "vitest";
import { assertVersionVisible, insertTemplateVersion, type DbLike } from "./outbound-access";

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

// ---------------------------------------------------------------------------
// insertTemplateVersion — §5.3's N+1, and the absence of any update path.
// ---------------------------------------------------------------------------

function makeWriteDb(latest: { version: number }[]) {
  const inserted: unknown[] = [];
  const select = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(latest),
  };
  const insertNode = {
    values: vi.fn().mockImplementation((v: unknown) => {
      inserted.push(v);
      return insertNode;
    }),
    returning: vi.fn().mockResolvedValue([{ id: "new-version", version: 0 }]),
  };
  const updateNode = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  return {
    inserted,
    select: vi.fn().mockReturnValue(select),
    insert: vi.fn().mockReturnValue(insertNode),
    update: vi.fn().mockReturnValue(updateNode),
  };
}

describe("insertTemplateVersion", () => {
  it("writes version N+1, reading N inside the caller's handle", async () => {
    const db = makeWriteDb([{ version: 3 }]);
    await insertTemplateVersion(
      db as unknown as DbLike,
      { tenantId: TENANT, userId: "u1" },
      { outboundTemplateId: "t1", html: "<p/>", slotsJson: [], inputsJson: [] },
    );
    expect(db.inserted[0]).toMatchObject({ outboundTemplateId: "t1", version: 4 });
  });

  it("starts at 1 for a template that has no versions yet", async () => {
    const db = makeWriteDb([]);
    await insertTemplateVersion(
      db as unknown as DbLike,
      { tenantId: TENANT, userId: "u1" },
      { outboundTemplateId: "t1", html: "<p/>", slotsJson: [], inputsJson: [] },
    );
    expect(db.inserted[0]).toMatchObject({ version: 1 });
  });

  it("never UPDATEs a version row — the immutability is held by absence", async () => {
    const db = makeWriteDb([{ version: 1 }]);
    await insertTemplateVersion(
      db as unknown as DbLike,
      { tenantId: TENANT, userId: "u1" },
      { outboundTemplateId: "t1", html: "<p/>", slotsJson: [], inputsJson: [] },
    );
    // The one UPDATE this function performs touches the PARENT template's
    // last_upd stamp, never the version.
    expect(db.update).toHaveBeenCalledTimes(1);
    const mod = await import("./outbound-access");
    expect(Object.keys(mod).some((k) => /updateVersion|editVersion/iu.test(k))).toBe(false);
  });
});
