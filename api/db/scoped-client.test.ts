// api/db/scoped-client.test.ts
//
// Proves the transaction-aware scope: ctx.db.withTx(tx) routes verbs through
// tx, and ctx.db.transaction flattens onto an already-bound tx instead of
// opening a nested SAVEPOINT. These two properties together prevent the
// Lambda max=1 pool deadlock the bug uncovered.

import { describe, it, expect, vi } from "vitest";
import { memberships, tenants } from "../../drizzle/schema";
import { createScopedDb, type Tx } from "./scoped-client";

type FakeTx = ReturnType<typeof makeFakeTx>;

function makeFakeTx(rows: unknown[] = [{ id: "row-1" }]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });

  const setReturning = vi.fn().mockResolvedValue(rows);
  const updateWhere = vi.fn().mockReturnValue({ returning: setReturning });
  const set = vi.fn().mockReturnValue({ where: updateWhere });
  const update = vi.fn().mockReturnValue({ set });

  return { select, from, where, limit, update, set, updateWhere, setReturning };
}

function buildScope() {
  return createScopedDb({
    userId: "user-1",
    tenantId: "tenant-1",
    tenantIndustry: "restaurant",
  });
}

describe("ScopedDb.withTx", () => {
  it("routes byId through the provided tx handle", async () => {
    const fakeTx: FakeTx = makeFakeTx();
    const txDb = buildScope().withTx(fakeTx as unknown as Tx);

    const row = await txDb.byId(tenants, "id-1");

    expect(fakeTx.select).toHaveBeenCalledOnce();
    expect(fakeTx.from).toHaveBeenCalledWith(tenants);
    expect(fakeTx.limit).toHaveBeenCalledWith(1);
    expect(row).toEqual({ id: "row-1" });
  });

  it("routes update through the provided tx handle and stamps system fields", async () => {
    const fakeTx: FakeTx = makeFakeTx([
      { id: "m-1", role: 10, lastUpdAt: "now", lastUpdBy: "user-1" },
    ]);
    const txDb = buildScope().withTx(fakeTx as unknown as Tx);

    await txDb.update(memberships, "m-1", { role: 10 });

    expect(fakeTx.update).toHaveBeenCalledWith(memberships);
    const stamped = fakeTx.set.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(stamped).toMatchObject({ role: 10, lastUpdBy: "user-1" });
    expect(stamped?.["lastUpdAt"]).toEqual(expect.any(String));
  });

  it("exposes the tx as .raw so escape-hatch raw queries reuse the connection", () => {
    const fakeTx = makeFakeTx();
    const txDb = buildScope().withTx(fakeTx as unknown as Tx);
    expect(txDb.raw).toBe(fakeTx);
  });
});

describe("ScopedDb.transaction", () => {
  it("flattens onto the existing tx when called from a withTx scope", async () => {
    const fakeTx: FakeTx = makeFakeTx();
    const txDb = buildScope().withTx(fakeTx as unknown as Tx);

    const calls: { sameDb: boolean; sameTx: boolean }[] = [];
    await txDb.transaction(async (innerDb, innerTx) => {
      calls.push({ sameDb: innerDb === txDb, sameTx: innerTx === (fakeTx as unknown as Tx) });
    });

    expect(calls).toEqual([{ sameDb: true, sameTx: true }]);
  });
});
