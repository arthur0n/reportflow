// api/services/calibration-freeze.test.ts
//
// The freeze. What is under test is not the SQL — it is the three decisions
// §3.1 and §12.8 make, each of which is invisible in a passing happy path:
//
//   * RECALIBRATION BUMPS, IT DOES NOT FORK (§12.8, "decided: invalidate").
//     A second freeze of the same document type updates the ONE live template
//     and increments `calibration_rev`. That increment is the entire staleness
//     mechanism — every existing extraction is keyed on the old rev and simply
//     misses the cache from then on.
//   * THE FIELD LIST IS REPLACED WHOLE. A partial diff would leave a template
//     whose fields came from two calibrations, which is exactly the versioning
//     §12.8 refused.
//   * THE FIXTURE IS VALIDATED AGAINST THE FROZEN LIST, not the proposed one.
//     A human may have renamed a field after the model filled in the values,
//     and a fixture that cannot satisfy the schema every future extraction is
//     checked by is not a fixture — it is a trap.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  documentTypes,
  documents,
  extractFields,
  extractTemplates,
  extractions,
  providers,
} from "../../drizzle/schema";
import type { DbLike } from "../collector/job-state";
import { freezeCalibration } from "./calibration-freeze";
import type { FreezeCalibrationInputT } from "../../shared/validation/calibration-schemas";

const TENANT = "org_2abcTENANT";
const USER = "user-1";
const DOC_ID = "22222222-2222-4222-8222-222222222222";
const PROVIDER_ID = "44444444-4444-4444-8444-444444444444";
const TYPE_ID = "55555555-5555-4555-8555-555555555555";
const TEMPLATE_ID = "66666666-6666-4666-8666-666666666666";
const S3_KEY = `${TENANT}/sample.pdf`;

interface Write {
  readonly table: unknown;
  readonly values: Record<string, unknown>;
}

function makeDb(opts: { selectQueue?: unknown[][]; insertQueue?: unknown[][] } = {}) {
  const selects = [...(opts.selectQueue ?? [])];
  const inserts = [...(opts.insertQueue ?? [])];
  const writes: Write[] = [];
  const updates: Write[] = [];

  const select = vi.fn().mockImplementation(() => {
    const rows = selects.shift() ?? [];
    const limit = vi.fn().mockResolvedValue(rows);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    return { from };
  });

  const insert = vi.fn().mockImplementation((table: unknown) => ({
    values: (values: Record<string, unknown>) => {
      writes.push({ table, values });
      const returning = vi.fn().mockImplementation(() => Promise.resolve(inserts.shift() ?? []));
      return { returning, onConflictDoNothing: () => ({ returning }) };
    },
  }));

  // Covers both update shapes: `.where(...)` awaited directly (every update
  // here) and `.where(...).returning()`.
  const update = vi.fn().mockImplementation((table: unknown) => ({
    set: (values: Record<string, unknown>) => {
      updates.push({ table, values });
      return {
        where: () => ({
          returning: vi.fn().mockResolvedValue([]),
          then: (resolve: (v: unknown) => void) => {
            resolve(undefined);
          },
        }),
      };
    },
  }));

  return { db: { select, insert, update } as unknown as DbLike, writes, updates };
}

const valuesFor = (rows: readonly Write[], table: unknown): Record<string, unknown>[] =>
  rows.filter((w) => w.table === table).map((w) => w.values);

const FIELDS: FreezeCalibrationInputT["fields"] = [
  { name: "numero", type: "string", required: true, description: "Número." },
  {
    name: "itens",
    type: "object[]",
    required: true,
    description: "Linhas.",
    fields: [
      { name: "descricao", type: "string", required: true, description: "Descrição." },
      { name: "total", type: "money", required: true, description: "Total." },
    ],
  },
];

function input(over: Partial<FreezeCalibrationInputT> = {}): FreezeCalibrationInputT {
  return {
    provider: { name: "Toysmith" },
    documentType: { name: "Nota Fiscal" },
    sampleDocumentId: DOC_ID,
    inputMode: "text",
    detectHint: ["TOYSMITH COMÉRCIO"],
    fields: FIELDS,
    ...over,
  };
}

const CTX = { tenantId: TENANT, userId: USER };

beforeEach(() => {
  vi.clearAllMocks();
});

/** A tenant calibrating this document type for the first time: no provider,
 * no document type, no live template. */
function firstFreezeDb(insertQueue: unknown[][]) {
  return makeDb({
    selectQueue: [
      [{ id: DOC_ID, s3Key: S3_KEY }], // sample document
      [], // no provider named Toysmith yet
      [], // no document type yet
      [], // no live template yet
    ],
    insertQueue,
  });
}

const FIELD_IDS = [[{ id: "f0" }], [{ id: "f1" }], [{ id: "f2" }], [{ id: "f3" }]];

describe("freezeCalibration — first calibration", () => {
  it("creates provider, type and template at calibration_rev 1", async () => {
    const { db, writes } = firstFreezeDb([
      [{ id: PROVIDER_ID }],
      [{ id: TYPE_ID }],
      [{ id: TEMPLATE_ID }],
      ...FIELD_IDS,
    ]);

    const out = await freezeCalibration(db, CTX, input());

    expect(out).toMatchObject({
      providerId: PROVIDER_ID,
      documentTypeId: TYPE_ID,
      templateId: TEMPLATE_ID,
      calibrationRev: 1,
      recalibrated: false,
      fieldCount: 4,
    });
    const template = valuesFor(writes, extractTemplates)[0];
    expect(template).toMatchObject({
      tenantId: TENANT,
      documentTypeId: TYPE_ID,
      inputMode: "text",
      calibrationRev: 1,
      // §3.1 — the PDF half of the golden fixture is the sample's own key.
      fixtureS3Key: S3_KEY,
    });
    expect(template?.["detectHint"]).toEqual(["TOYSMITH COMÉRCIO"]);
    expect(valuesFor(writes, providers)[0]).toMatchObject({ tenantId: TENANT, name: "Toysmith" });
    expect(valuesFor(writes, documentTypes)[0]).toMatchObject({ providerId: PROVIDER_ID });
  });

  // The nesting §3.1 needs for line items: a flat list cannot express
  // `itens[].total`, and the child rows have to point at the parent row the
  // same insert pass just created.
  it("writes the field list depth-first with parents resolved to child rows", async () => {
    const { db, writes } = firstFreezeDb([
      [{ id: PROVIDER_ID }],
      [{ id: TYPE_ID }],
      [{ id: TEMPLATE_ID }],
      ...FIELD_IDS,
    ]);

    await freezeCalibration(db, CTX, input());

    const fields = valuesFor(writes, extractFields);
    expect(fields.map((f) => f["name"])).toEqual(["numero", "itens", "descricao", "total"]);
    expect(fields.map((f) => f["parentFieldId"])).toEqual([null, null, "f1", "f1"]);
    expect(fields.map((f) => f["sortOrder"])).toEqual([0, 1, 0, 1]);
    expect(fields.every((f) => f["extractTemplateId"] === TEMPLATE_ID)).toBe(true);
  });

  // The human just declared what this document IS — tier 3's answer (§3.3)
  // through a different door, and `manual` is the one value no later detection
  // may overwrite.
  it("stamps the sample document with the type it was just calibrated for", async () => {
    const { db, updates } = firstFreezeDb([
      [{ id: PROVIDER_ID }],
      [{ id: TYPE_ID }],
      [{ id: TEMPLATE_ID }],
      ...FIELD_IDS,
    ]);

    await freezeCalibration(db, CTX, input());

    expect(valuesFor(updates, documents)[0]).toMatchObject({
      documentTypeId: TYPE_ID,
      detectedBy: "manual",
    });
  });
});

describe("freezeCalibration — the golden fixture (§3.1)", () => {
  it("stores the confirmed JSON as a corrected extraction at the new rev", async () => {
    const { db, writes } = firstFreezeDb([
      [{ id: PROVIDER_ID }],
      [{ id: TYPE_ID }],
      [{ id: TEMPLATE_ID }],
      ...FIELD_IDS,
      [{ id: "extraction-1" }],
    ]);

    const out = await freezeCalibration(
      db,
      CTX,
      input({
        confirmedJson: {
          numero: "FT A2024/1",
          itens: [{ descricao: "linha", total: "10,00 €" }],
        },
      }),
    );

    expect(out.fixtureJsonStored).toBe(true);
    expect(valuesFor(writes, extractions)[0]).toMatchObject({
      tenantId: TENANT,
      documentId: DOC_ID,
      extractTemplateId: TEMPLATE_ID,
      s3Key: S3_KEY,
      calibrationRev: 1,
      corrected: true,
    });
  });

  // Catches the version of this that "helpfully" stores the values anyway: a
  // fixture that does not satisfy the frozen schema would report drift on a
  // document that never drifted.
  it("skips a confirmed JSON that does not match the frozen list, and says so", async () => {
    const { db, writes } = firstFreezeDb([
      [{ id: PROVIDER_ID }],
      [{ id: TYPE_ID }],
      [{ id: TEMPLATE_ID }],
      ...FIELD_IDS,
    ]);

    const out = await freezeCalibration(
      db,
      CTX,
      // `numero_documento` is a field the human renamed away from.
      input({ confirmedJson: { numero_documento: "FT A2024/1" } }),
    );

    expect(out.fixtureJsonStored).toBe(false);
    expect(out.fixtureJsonSkippedReason).toContain("não corresponde");
    expect(valuesFor(writes, extractions)).toHaveLength(0);
  });

  it("freezes without a fixture JSON at all", async () => {
    const { db, writes } = firstFreezeDb([
      [{ id: PROVIDER_ID }],
      [{ id: TYPE_ID }],
      [{ id: TEMPLATE_ID }],
      ...FIELD_IDS,
    ]);

    const out = await freezeCalibration(db, CTX, input());

    expect(out.fixtureJsonStored).toBe(false);
    expect(valuesFor(writes, extractions)).toHaveLength(0);
  });
});

describe("freezeCalibration — recalibration (§12.8)", () => {
  it("bumps calibration_rev on the live template instead of creating a second one", async () => {
    const { db, writes, updates } = makeDb({
      selectQueue: [
        [{ id: DOC_ID, s3Key: S3_KEY }],
        [{ id: PROVIDER_ID }], // provider already exists
        [{ id: TYPE_ID }], // type already exists
        [{ id: TEMPLATE_ID, calibrationRev: 3 }], // live template
      ],
      insertQueue: [[{ id: "f0" }], [{ id: "f1" }], [{ id: "f2" }], [{ id: "f3" }]],
    });

    const out = await freezeCalibration(db, CTX, input({ inputMode: "vision" }));

    expect(out).toMatchObject({
      templateId: TEMPLATE_ID,
      calibrationRev: 4,
      recalibrated: true,
    });
    // No second template row: Calibrate replaces, never forks.
    expect(valuesFor(writes, extractTemplates)).toHaveLength(0);
    expect(valuesFor(updates, extractTemplates)[0]).toMatchObject({
      calibrationRev: 4,
      inputMode: "vision",
      fixtureS3Key: S3_KEY,
    });
  });

  // Replace-all: the previous list is soft-deleted (which also frees the names
  // under the partial unique indexes) before the new one is written.
  it("soft-deletes the previous field list before inserting the new one", async () => {
    const { db, updates, writes } = makeDb({
      selectQueue: [
        [{ id: DOC_ID, s3Key: S3_KEY }],
        [{ id: PROVIDER_ID }],
        [{ id: TYPE_ID }],
        [{ id: TEMPLATE_ID, calibrationRev: 1 }],
      ],
      insertQueue: [[{ id: "f0" }], [{ id: "f1" }], [{ id: "f2" }], [{ id: "f3" }]],
    });

    await freezeCalibration(db, CTX, input());

    const softDelete = valuesFor(updates, extractFields)[0];
    expect(softDelete?.["deletedBy"]).toBe(USER);
    expect(softDelete?.["deletedAt"]).toEqual(expect.any(String));
    expect(valuesFor(writes, extractFields)).toHaveLength(4);
  });

  it("stores the fixture at the NEW rev, so the old extraction stays keyed to the old one", async () => {
    const { db, writes } = makeDb({
      selectQueue: [
        [{ id: DOC_ID, s3Key: S3_KEY }],
        [{ id: PROVIDER_ID }],
        [{ id: TYPE_ID }],
        [{ id: TEMPLATE_ID, calibrationRev: 7 }],
      ],
      insertQueue: [
        [{ id: "f0" }],
        [{ id: "f1" }],
        [{ id: "f2" }],
        [{ id: "f3" }],
        [{ id: "extraction-2" }],
      ],
    });

    await freezeCalibration(
      db,
      CTX,
      input({ confirmedJson: { numero: "1", itens: [{ descricao: "a", total: "1,00 €" }] } }),
    );

    expect(valuesFor(writes, extractions)[0]).toMatchObject({ calibrationRev: 8 });
  });
});

describe("freezeCalibration — ownership", () => {
  it("refuses a sample document that is not the caller's", async () => {
    const { db } = makeDb({ selectQueue: [[]] });
    await expect(freezeCalibration(db, CTX, input())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses a provider id that is not the caller's", async () => {
    const { db } = makeDb({ selectQueue: [[{ id: DOC_ID, s3Key: S3_KEY }], []] });
    await expect(
      freezeCalibration(db, CTX, input({ provider: { id: PROVIDER_ID } })),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  // `document_types` is unique on (provider_id, name), so a type id from
  // ANOTHER provider would silently re-parent the template.
  it("refuses a document type id that does not belong to the given provider", async () => {
    const { db } = makeDb({
      selectQueue: [[{ id: DOC_ID, s3Key: S3_KEY }], [{ name: "Toysmith" }], []],
    });
    await expect(
      freezeCalibration(
        db,
        CTX,
        input({ provider: { id: PROVIDER_ID }, documentType: { id: TYPE_ID } }),
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
