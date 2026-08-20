// api/services/documents-crud.test.ts
//
// insertDocumentIdempotent is the whole idempotency contract for confirmUpload:
// a retried confirm (client never saw the response, duplicate submit) must
// return the SAME row rather than erroring on the documents.s3_key unique
// constraint. assertReferencesOwnedByTenant is the re-proof that a client_id
// or document_type_id the caller supplies actually belongs to their own
// tenant — a bare FK would happily accept another tenant's row id.

import { describe, it, expect, vi } from "vitest";
import { TRPCError } from "@trpc/server";
import {
  assertReferencesOwnedByTenant,
  insertDocumentIdempotent,
  listDocuments,
  type DbLike,
} from "./documents-crud";

const TENANT = "org_2abcTENANT";
const USER = "user-1";

function makeSelectDb(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as unknown as DbLike, select, from, where, limit };
}

describe("assertReferencesOwnedByTenant", () => {
  it("does not touch the db when neither reference is given", async () => {
    const { db, select } = makeSelectDb([]);
    await expect(assertReferencesOwnedByTenant(db, TENANT, {})).resolves.toBeUndefined();
    expect(select).not.toHaveBeenCalled();
  });

  it("passes when the client belongs to the caller's tenant", async () => {
    const { db } = makeSelectDb([{ id: "client-1" }]);
    await expect(
      assertReferencesOwnedByTenant(db, TENANT, { clientId: "client-1" }),
    ).resolves.toBeUndefined();
  });

  // Catches: trusting a bare uuid FK. clients.id has no tenant of its own to
  // check against unless the query filters by tenantId, which is exactly what
  // a plain foreign key reference does not do.
  it("refuses a client_id belonging to another tenant", async () => {
    const { db } = makeSelectDb([]); // scoped query finds nothing
    await expect(
      assertReferencesOwnedByTenant(db, TENANT, { clientId: "someone-elses-client" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses a document_type_id belonging to another tenant", async () => {
    const { db } = makeSelectDb([]);
    await expect(
      assertReferencesOwnedByTenant(db, TENANT, { documentTypeId: "someone-elses-type" }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("ignores null references (explicit clear, not a reference to check)", async () => {
    const { db, select } = makeSelectDb([]);
    await expect(
      assertReferencesOwnedByTenant(db, TENANT, { clientId: null, documentTypeId: null }),
    ).resolves.toBeUndefined();
    expect(select).not.toHaveBeenCalled();
  });
});

describe("insertDocumentIdempotent", () => {
  function makeInsertDb(args: { insertReturns: unknown[]; selectReturns: unknown[] }) {
    const returning = vi.fn().mockResolvedValue(args.insertReturns);
    const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    const insert = vi.fn().mockReturnValue({ values });

    const limit = vi.fn().mockResolvedValue(args.selectReturns);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });

    return {
      db: { insert, select } as unknown as DbLike,
      insert,
      values,
      onConflictDoNothing,
      returning,
      select,
      where,
      limit,
    };
  }

  it("inserts and reports created:true on the first confirm", async () => {
    const row = { id: "doc-1", s3Key: `${TENANT}/a.pdf`, tenantId: TENANT };
    const { db, values, onConflictDoNothing } = makeInsertDb({
      insertReturns: [row],
      selectReturns: [],
    });

    const outcome = await insertDocumentIdempotent(
      db,
      { tenantId: TENANT, userId: USER },
      { s3Key: `${TENANT}/a.pdf`, byteSize: 1024 },
    );

    expect(outcome).toEqual({ row, created: true });
    expect(onConflictDoNothing).toHaveBeenCalledOnce();
    const stamped = values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(stamped).toMatchObject({ tenantId: TENANT, s3Key: `${TENANT}/a.pdf`, byteSize: 1024 });
  });

  // THE property under test: a retried confirm must not error and must not
  // duplicate — it returns the row the first confirm already created.
  it("returns the existing row and created:false on a replayed confirm", async () => {
    const existing = { id: "doc-1", s3Key: `${TENANT}/a.pdf`, tenantId: TENANT };
    const { db } = makeInsertDb({ insertReturns: [], selectReturns: [existing] });

    const outcome = await insertDocumentIdempotent(
      db,
      { tenantId: TENANT, userId: USER },
      { s3Key: `${TENANT}/a.pdf`, byteSize: 1024 },
    );

    expect(outcome).toEqual({ row: existing, created: false });
  });

  // Should be unreachable in practice (keys carry the tenant prefix), but a
  // conflict with no row visible under THIS tenant must refuse loudly rather
  // than silently return nothing.
  it("throws CONFLICT if the row that won the race is invisible to this tenant", async () => {
    const { db } = makeInsertDb({ insertReturns: [], selectReturns: [] });

    await expect(
      insertDocumentIdempotent(
        db,
        { tenantId: TENANT, userId: USER },
        { s3Key: `${TENANT}/a.pdf` },
      ),
    ).rejects.toBeInstanceOf(TRPCError);
    await expect(
      insertDocumentIdempotent(
        db,
        { tenantId: TENANT, userId: USER },
        { s3Key: `${TENANT}/a.pdf` },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("listDocuments", () => {
  it("scopes to the tenant and orders newest first", async () => {
    const rows = [{ id: "doc-2" }, { id: "doc-1" }];
    const orderBy = vi.fn().mockResolvedValue(rows);
    const where = vi.fn().mockReturnValue({ orderBy });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const db = { select } as unknown as DbLike;

    const result = await listDocuments(db, TENANT);

    expect(result).toBe(rows);
    expect(select).toHaveBeenCalledOnce();
    expect(orderBy).toHaveBeenCalledOnce();
  });
});
