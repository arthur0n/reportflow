// api/collector/extraction-store.test.ts
//
// `unique(s3_key, calibration_rev)` (§12.8) is the extraction cache, and ON
// CONFLICT DO NOTHING against it is what makes an at-least-once S3 event safe
// to receive twice. These cases pin the conflict TARGET as well as the
// behaviour: a conflict clause aimed at the wrong columns still compiles, still
// passes a happy-path test, and silently stops being idempotent.

import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { extractions } from "../../drizzle/schema";
import {
  insertExtractionIdempotent,
  loadTemplateFields,
  resolveExtractionTarget,
} from "./extraction-store";
import type { DbLike } from "./job-state";

const TENANT = "org_2abcTENANT";
const DOC_ID = "22222222-2222-4222-8222-222222222222";

const dialect = new PgDialect();

function rendered(fn: ReturnType<typeof vi.fn>, call = 0, arg = 0): string {
  return dialect.sqlToQuery(fn.mock.calls[call]?.[arg] as SQL).sql;
}

function makeJoinDb(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const innerJoin = vi.fn().mockReturnValue({ where });
  const from = vi.fn().mockReturnValue({ innerJoin });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as unknown as DbLike, innerJoin, where };
}

function makeInsertDb(inserted: unknown[]) {
  const returning = vi.fn().mockResolvedValue(inserted);
  const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoNothing });
  const insert = vi.fn().mockReturnValue({ values });
  return { db: { insert } as unknown as DbLike, values, onConflictDoNothing };
}

const TARGET = {
  documentId: DOC_ID,
  extractTemplateId: "33333333-3333-4333-8333-333333333333",
  s3Key: `${TENANT}/doc.pdf`,
  calibrationRev: 2,
};

describe("resolveExtractionTarget", () => {
  it("returns the document and its live template's calibration rev", async () => {
    const { db } = makeJoinDb([TARGET]);
    await expect(resolveExtractionTarget(db, TENANT, DOC_ID)).resolves.toEqual(TARGET);
  });

  // Not a transient failure and not the model's fault: no detected type, or a
  // soft-deleted template. The caller must send it to `revisar`, not retry it.
  it("returns null when the document has no live extract template", async () => {
    const { db } = makeJoinDb([]);
    await expect(resolveExtractionTarget(db, TENANT, DOC_ID)).resolves.toBeNull();
  });

  // The collector runs outside a user request. Both sides of the join carry the
  // tenant, so a document id alone cannot reach another tenant's template.
  it("scopes both the document and the template to the tenant", async () => {
    const { db, innerJoin, where } = makeJoinDb([TARGET]);
    await resolveExtractionTarget(db, TENANT, DOC_ID);
    expect(rendered(innerJoin, 0, 1)).toContain('"extract_templates"."tenant_id"');
    expect(rendered(innerJoin, 0, 1)).toContain('"extract_templates"."deleted_at" is null');
    expect(rendered(where)).toContain('"documents"."tenant_id"');
    expect(rendered(where)).toContain('"documents"."deleted_at" is null');
  });
});

describe("insertExtractionIdempotent", () => {
  it("writes the payload with its provenance and reports created:true", async () => {
    const { db, values } = makeInsertDb([{ id: "extraction-1" }]);
    await expect(
      insertExtractionIdempotent(
        db,
        TENANT,
        TARGET,
        { total: 10 },
        {
          provider: "gemini",
          model: "gemini-2.5-pro",
        },
      ),
    ).resolves.toEqual({ created: true });
    const payload = values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      tenantId: TENANT,
      documentId: DOC_ID,
      s3Key: `${TENANT}/doc.pdf`,
      calibrationRev: 2,
      data: { total: 10 },
      provider: "gemini",
      model: "gemini-2.5-pro",
    });
  });

  // THE property: the second delivery of the same result inserts nothing and
  // says so, rather than raising a constraint violation the caller would have
  // to tell apart from a real fault.
  it("reports created:false when the row was already cached", async () => {
    const { db } = makeInsertDb([]);
    await expect(
      insertExtractionIdempotent(
        db,
        TENANT,
        TARGET,
        { total: 10 },
        {
          provider: "gemini",
          model: "m",
        },
      ),
    ).resolves.toEqual({ created: false });
  });

  // §12.8 — the cache key is (s3_key, calibration_rev). A conflict clause on
  // s3_key alone would make a recalibration overwrite nothing and cache the
  // stale extraction forever.
  it("conflicts on the full cache key", async () => {
    const { db, onConflictDoNothing } = makeInsertDb([{ id: "x" }]);
    await insertExtractionIdempotent(db, TENANT, TARGET, {}, { provider: "p", model: "m" });
    const clause = onConflictDoNothing.mock.calls[0]?.[0] as { target: unknown[] };
    expect(clause.target).toEqual([extractions.s3Key, extractions.calibrationRev]);
  });

  // No user did this. A sentinel in an audit column is a value no audit can
  // ever resolve — and `created_by` is a uuid, so a string like "collector"
  // would not even survive the insert.
  it("leaves created_by / last_upd_by unset", async () => {
    const { db, values } = makeInsertDb([{ id: "x" }]);
    await insertExtractionIdempotent(db, TENANT, TARGET, {}, { provider: "p", model: "m" });
    const payload = values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect("createdBy" in payload).toBe(false);
    expect("lastUpdBy" in payload).toBe(false);
  });
});

// The collector needs the frozen list to decide §4.2's fork, and it must be
// the SAME tree `buildZodSchema`, the extractor prompt and the repair screen
// read — `parent_field_id` must not leak past this function.
describe("loadTemplateFields", () => {
  function makeFieldDb(rows: unknown[]) {
    const where = vi.fn().mockResolvedValue(rows);
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    return { db: { select } as unknown as DbLike, where };
  }

  it("returns the ordered tree, nesting resolved from parent_field_id", async () => {
    const { db } = makeFieldDb([
      {
        id: "f-2",
        parentFieldId: null,
        name: "itens",
        type: "object[]",
        required: true,
        description: "linhas",
        sortOrder: 1,
      },
      {
        id: "f-1",
        parentFieldId: null,
        name: "numero",
        type: "string",
        required: true,
        description: "nº",
        sortOrder: 0,
      },
      {
        id: "f-3",
        parentFieldId: "f-2",
        name: "total",
        type: "money",
        required: true,
        description: "total da linha",
        sortOrder: 0,
      },
    ]);

    const fields = await loadTemplateFields(db, TENANT, TARGET.extractTemplateId);

    expect(fields.map((f) => f.name)).toEqual(["numero", "itens"]);
    expect(fields[1]?.fields?.map((f) => f.name)).toEqual(["total"]);
  });

  // Tenant-scoped even though the template id is already the tenant's: the id
  // arrives from a row this function did not read.
  it("scopes the read by tenant and by template, excluding soft-deleted rows", async () => {
    const { db, where } = makeFieldDb([]);
    await loadTemplateFields(db, TENANT, TARGET.extractTemplateId);
    const sql = rendered(where);
    expect(sql).toContain('"tenant_id" =');
    expect(sql).toContain('"extract_template_id" =');
    expect(sql).toContain('"deleted_at" is null');
  });
});
