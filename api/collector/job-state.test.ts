// api/collector/job-state.test.ts
//
// The state machine is the whole safety argument for having two writers on one
// row (decisions §12.1), so these cases are about the SQL, not about the return
// value: a transition whose expected state is not in the WHERE clause is a
// read-modify-write wearing a compare-and-set's clothes, and it would pass any
// test that only checked what the function returns.
//
// The WHERE clauses are rendered with drizzle's own dialect and asserted as
// text. That is deliberate — it is the only way to prove `status` and `attempt`
// are actually part of the predicate rather than merely being read somewhere.

import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  casAttempt,
  confirmEnqueue,
  ENQUEUE_PENDING_MARKER,
  isAwaitingEnqueue,
  isForward,
  isTerminal,
  JOB_KINDS,
  JOB_STATUSES,
  loadJobById,
  loadJobByS3Key,
  loadLatestJobForDocument,
  MAX_ATTEMPTS,
  resolveRevisarJob,
  transition,
  type DbLike,
  type JobStatus,
} from "./job-state";

const TENANT = "org_2abcTENANT";
const OTHER_TENANT = "org_2zzzOTHER";
const ROW_ID = "11111111-1111-4111-8111-111111111111";

const dialect = new PgDialect();

function renderedWhere(where: ReturnType<typeof vi.fn>): { sql: string; params: unknown[] } {
  const clause = where.mock.calls[0]?.[0] as SQL;
  const query = dialect.sqlToQuery(clause);
  return { sql: query.sql, params: query.params };
}

function makeUpdateDb(matched: number) {
  const returning = vi
    .fn()
    .mockResolvedValue(Array.from({ length: matched }, () => ({ id: ROW_ID })));
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });
  return { db: { update } as unknown as DbLike, update, set, where, returning };
}

function makeSelectDb(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as unknown as DbLike, select, from, where, limit };
}

describe("the status/kind vocabularies", () => {
  // Two statements of the same list — this one and the CHECK constraints in
  // drizzle/tables/pipeline.ts. Pinned so a new status has to be added in both.
  it("matches report_jobs_status_check and report_jobs_kind_check", () => {
    expect([...JOB_STATUSES]).toEqual(["pending", "revisar", "done", "failed"]);
    expect([...JOB_KINDS]).toEqual(["detect", "extract", "analyse", "verify"]);
  });

  // §4.2 — "auto-retry once", and attempts are 1-based because the jobId's
  // `-a{n}` suffix is (api/lib/relay.ts).
  it("allows exactly one retry", () => {
    expect(MAX_ATTEMPTS).toBe(2);
  });
});

describe("isForward / isTerminal", () => {
  it("lets pending reach every terminal status", () => {
    expect(isForward("pending", "done")).toBe(true);
    expect(isForward("pending", "revisar")).toBe(true);
    expect(isForward("pending", "failed")).toBe(true);
  });

  // THE rule of §12.1: status only moves forward. Every one of these is a
  // regression or a re-settle, and every one is refused.
  it("refuses every regression and every terminal-to-terminal move", () => {
    const terminal: JobStatus[] = ["revisar", "done", "failed"];
    for (const from of terminal) {
      for (const to of JOB_STATUSES) {
        expect(isForward(from, to)).toBe(false);
      }
    }
    expect(isForward("pending", "pending")).toBe(false);
  });

  it("calls everything but pending settled", () => {
    expect(isTerminal("pending")).toBe(false);
    expect(isTerminal("revisar")).toBe(true);
    expect(isTerminal("done")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
  });
});

describe("transition", () => {
  it("reports true when this caller moved the row", async () => {
    const { db } = makeUpdateDb(1);
    await expect(
      transition(db, { tenantId: TENANT, id: ROW_ID, from: "pending", to: "done", attempt: 1 }),
    ).resolves.toBe(true);
  });

  // The duplicate delivery, and the concurrent poll. Both land here, and
  // "someone else got there first" is an ordinary outcome, not an error.
  it("reports false when the row was already moved by the other writer", async () => {
    const { db } = makeUpdateDb(0);
    await expect(
      transition(db, { tenantId: TENANT, id: ROW_ID, from: "pending", to: "done", attempt: 1 }),
    ).resolves.toBe(false);
  });

  // Catches: reading the row, deciding, then writing the status back. That
  // passes every behavioural test and loses every race.
  it("puts the expected status AND attempt in the WHERE clause", async () => {
    const { db, where } = makeUpdateDb(1);
    await transition(db, {
      tenantId: TENANT,
      id: ROW_ID,
      from: "pending",
      to: "revisar",
      attempt: 2,
    });
    const { sql, params } = renderedWhere(where);
    expect(sql).toContain('"report_jobs"."status" =');
    expect(sql).toContain('"report_jobs"."attempt" =');
    expect(sql).toContain('"report_jobs"."tenant_id" =');
    expect(sql).toContain('"report_jobs"."id" =');
    expect(params).toEqual([ROW_ID, TENANT, "pending", 2]);
  });

  // The collector runs outside a user request; the tenant it was sent to is the
  // only one it may touch.
  it("scopes to the tenant it was given, not to the row alone", async () => {
    const { db, where } = makeUpdateDb(0);
    await transition(db, {
      tenantId: OTHER_TENANT,
      id: ROW_ID,
      from: "pending",
      to: "done",
      attempt: 1,
    });
    expect(renderedWhere(where).params).toContain(OTHER_TENANT);
  });

  it("writes the patch alongside the status and stamps last_upd_at", async () => {
    const { db, set } = makeUpdateDb(1);
    await transition(db, {
      tenantId: TENANT,
      id: ROW_ID,
      from: "pending",
      to: "revisar",
      attempt: 1,
      patch: { error: "boom", result: { error: { type: "permanent", message: "boom" } } },
    });
    const payload = set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload["status"]).toBe("revisar");
    expect(payload["error"]).toBe("boom");
    expect(payload["result"]).toEqual({ error: { type: "permanent", message: "boom" } });
    expect(typeof payload["lastUpdAt"]).toBe("string");
  });

  // Catches: an absent patch key becoming an explicit NULL and wiping the
  // column a previous attempt wrote.
  it("does not write patch columns that were not supplied", async () => {
    const { db, set } = makeUpdateDb(1);
    await transition(db, { tenantId: TENANT, id: ROW_ID, from: "pending", to: "done", attempt: 1 });
    const payload = set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("error" in payload).toBe(false);
    expect("result" in payload).toBe(false);
  });

  // A regression is a caller bug, and `false` would let it read as a lost race
  // and be swallowed by the very code that handles lost races.
  it("throws rather than returning false on a backwards move", async () => {
    const { db, update } = makeUpdateDb(1);
    await expect(
      transition(db, { tenantId: TENANT, id: ROW_ID, from: "done", to: "pending", attempt: 1 }),
    ).rejects.toThrow(/forward/u);
    await expect(
      transition(db, { tenantId: TENANT, id: ROW_ID, from: "revisar", to: "done", attempt: 1 }),
    ).rejects.toThrow(/forward/u);
    await expect(
      transition(db, { tenantId: TENANT, id: ROW_ID, from: "done", to: "failed", attempt: 1 }),
    ).rejects.toThrow(/forward/u);
    // And it refused before touching the database.
    expect(update).not.toHaveBeenCalled();
  });
});

describe("casAttempt", () => {
  it("bumps the attempt and the job key, leaving the row pending", async () => {
    const { db, set, where } = makeUpdateDb(1);
    const moved = await casAttempt(db, {
      tenantId: TENANT,
      id: ROW_ID,
      fromAttempt: 1,
      toAttempt: 2,
      s3Key: `jobs/${TENANT}/uuid-a2.json`,
      error: "tentativa 1: timeout",
    });
    expect(moved).toBe(true);
    const payload = set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload["attempt"]).toBe(2);
    expect(payload["s3Key"]).toBe(`jobs/${TENANT}/uuid-a2.json`);
    expect("status" in payload).toBe(false);
    const { sql, params } = renderedWhere(where);
    expect(sql).toContain('"report_jobs"."status" =');
    expect(params).toEqual([ROW_ID, TENANT, "pending", 1]);
  });

  // TWO collectors reading the same failed result: one wins the bump and pays
  // for the retry, the other is told it lost.
  it("reports false when another writer already bumped the attempt", async () => {
    const { db } = makeUpdateDb(0);
    await expect(
      casAttempt(db, {
        tenantId: TENANT,
        id: ROW_ID,
        fromAttempt: 1,
        toAttempt: 2,
        s3Key: `jobs/${TENANT}/uuid-a2.json`,
      }),
    ).resolves.toBe(false);
  });

  // The rollback in collect.ts is this same call with the attempts swapped.
  it("rolls an attempt back when called in reverse", async () => {
    const { db, set, where } = makeUpdateDb(1);
    await casAttempt(db, {
      tenantId: TENANT,
      id: ROW_ID,
      fromAttempt: 2,
      toAttempt: 1,
      s3Key: `jobs/${TENANT}/uuid-a1.json`,
      error: null,
    });
    expect((set.mock.calls[0]?.[0] as Record<string, unknown>)["attempt"]).toBe(1);
    expect(renderedWhere(where).params).toEqual([ROW_ID, TENANT, "pending", 2]);
  });
});

// The marker is what tells a wedged retry (bumped, never enqueued) apart from a
// healthy one (bumped, running). Both are `pending` at attempt n+1; without it,
// recovering the first would kill the second.
describe("the enqueue marker", () => {
  it("recognises a row whose retry is not yet confirmed", () => {
    const row = { error: `${ENQUEUE_PENDING_MARKER} tentativa 1: 429` } as never;
    expect(isAwaitingEnqueue(row)).toBe(true);
  });

  it("does not mistake an ordinary error, or none, for one", () => {
    expect(isAwaitingEnqueue({ error: "tentativa 1: 429" } as never)).toBe(false);
    expect(isAwaitingEnqueue({ error: null } as never)).toBe(false);
    expect(isAwaitingEnqueue({ error: `x ${ENQUEUE_PENDING_MARKER}` } as never)).toBe(false);
  });

  it("clears the marker under the same CAS guard as the bump", async () => {
    const { db, set, where } = makeUpdateDb(1);
    await expect(
      confirmEnqueue(db, { tenantId: TENANT, id: ROW_ID, attempt: 2, error: "tentativa 1: 429" }),
    ).resolves.toBe(true);
    const payload = set.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload["error"]).toBe("tentativa 1: 429");
    // Status and attempt are untouched — this only clears the marker.
    expect("status" in payload).toBe(false);
    expect("attempt" in payload).toBe(false);
    expect(renderedWhere(where).params).toEqual([ROW_ID, TENANT, "pending", 2]);
  });

  it("reports false when the row has already moved on", async () => {
    const { db } = makeUpdateDb(0);
    await expect(
      confirmEnqueue(db, { tenantId: TENANT, id: ROW_ID, attempt: 2, error: "x" }),
    ).resolves.toBe(false);
  });
});

describe("loadJobByS3Key / loadJobById", () => {
  it("filters by tenant as well as by key", async () => {
    const row = { id: ROW_ID, tenantId: TENANT };
    const { db, where } = makeSelectDb([row]);
    await expect(loadJobByS3Key(db, TENANT, `jobs/${TENANT}/uuid-a1.json`)).resolves.toBe(row);
    expect(renderedWhere(where).params).toEqual([`jobs/${TENANT}/uuid-a1.json`, TENANT]);
  });

  it("returns undefined when the row is not this tenant's", async () => {
    const { db, where } = makeSelectDb([]);
    await expect(loadJobById(db, OTHER_TENANT, ROW_ID)).resolves.toBeUndefined();
    expect(renderedWhere(where).params).toEqual([ROW_ID, OTHER_TENANT]);
  });
});

// §4.2's one human-driven transition. It is not routed through `transition`
// (whose forward-only rule is about the MACHINE's writes, where the only legal
// move is out of `pending`), so it needs its own proof that it is still a
// compare-and-set and still tenant-scoped.
describe("resolveRevisarJob — the human's revisar → done", () => {
  it("compare-and-sets on tenant, document, kind AND status = revisar", async () => {
    const { db, set, where } = makeUpdateDb(1);

    await resolveRevisarJob(db, {
      tenantId: TENANT,
      userId: "user-1",
      documentId: ROW_ID,
      kind: "extract",
    });

    const { sql, params } = renderedWhere(where);
    expect(sql).toContain('"tenant_id" =');
    expect(sql).toContain('"document_id" =');
    expect(sql).toContain('"kind" =');
    expect(sql).toContain('"status" =');
    expect(params).toContain(TENANT);
    expect(params).toContain("extract");
    expect(params).toContain("revisar");

    // Unlike every other write in this file, a PERSON did this one.
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "done", lastUpdBy: "user-1" }),
    );
  });

  // A double-clicked [Salvar correção], or two tabs. Nothing matched is an
  // ordinary outcome, not an error.
  it("reports zero when the row has already been resolved", async () => {
    const { db } = makeUpdateDb(0);
    await expect(
      resolveRevisarJob(db, {
        tenantId: TENANT,
        userId: "user-1",
        documentId: ROW_ID,
        kind: "extract",
      }),
    ).resolves.toBe(0);
  });

  it("cannot reach another tenant's row", async () => {
    const { db, where } = makeUpdateDb(0);
    await resolveRevisarJob(db, {
      tenantId: OTHER_TENANT,
      userId: "user-1",
      documentId: ROW_ID,
      kind: "extract",
    });
    expect(renderedWhere(where).params).toContain(OTHER_TENANT);
    expect(renderedWhere(where).params).not.toContain(TENANT);
  });
});

describe("loadLatestJobForDocument", () => {
  it("scopes by tenant, document and kind", async () => {
    const rows = [{ id: ROW_ID }];
    const limit = vi.fn().mockResolvedValue(rows);
    const orderBy = vi.fn().mockReturnValue({ limit });
    const where = vi.fn().mockReturnValue({ orderBy });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const db = { select } as unknown as DbLike;

    await expect(loadLatestJobForDocument(db, TENANT, ROW_ID, "extract")).resolves.toEqual(rows[0]);

    const { params } = renderedWhere(where);
    expect(params).toContain(TENANT);
    expect(params).toContain("extract");
  });
});
