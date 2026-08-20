// api/services/outbound-template-service.test.ts
//
// What is under test is what this service DECIDES: which slot list a version
// gets, what it refuses to write, and that a save is always an INSERT of N+1.
// The gate itself is proven in api/render/handlebars.test.ts and the aggregate
// builder in api/render/report-context.test.ts — restating them here would be
// two copies of one assertion, and the copy nobody looks at is the one that
// rots.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DbLike } from "../collector/job-state";

const access = vi.hoisted(() => ({
  getOutboundTemplate: vi.fn(),
  insertOutboundTemplate: vi.fn(),
  insertTemplateVersion: vi.fn(),
  listLatestVersions: vi.fn(),
  listOutboundTemplateVersions: vi.fn(),
  listOutboundTemplates: vi.fn(),
}));
vi.mock("../db/outbound-access", () => access);

const { loadFixtureBindings, resolveRoles, saveVersion, validateTemplate } =
  await import("./outbound-template-service");

const TENANT = "org_2abcTENANT";
const USER = "user-1";
const CTX = { tenantId: TENANT, userId: USER };
const TEMPLATE_ID = "33333333-3333-4333-8333-333333333333";
const TYPE_ID = "11111111-1111-4111-8111-111111111111";

const ROLE = {
  key: "faturas",
  documentTypeId: TYPE_ID,
  provider: "House Living",
  documentType: "Fatura",
  cardinality: "many" as const,
  required: true,
};

const FIXTURE_DATA = {
  numero: "FT 1",
  totais: { iliquido: "100,00 €", iva: "23,00 €", documento: "123,00 €" },
};

/** Fake handle. `selectQueue` is consumed IN ORDER, one array of rows per
 * `select()` — the same shape extraction-service.test.ts uses, because the
 * property under test is never the SQL, it is which read happened and what the
 * code did with the answer. */
function makeDb(selectQueue: unknown[][]) {
  const queue = [...selectQueue];
  const chain = (): Record<string, unknown> => {
    const rows = queue.shift() ?? [];
    const node: Record<string, unknown> = {};
    for (const verb of ["from", "innerJoin", "leftJoin", "where", "orderBy"]) {
      node[verb] = vi.fn().mockReturnValue(node);
    }
    node["limit"] = vi.fn().mockResolvedValue(rows);
    node["then"] = (resolve: (v: unknown) => unknown) => resolve(rows);
    return node;
  };
  return { select: vi.fn().mockImplementation(chain) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe("resolveRoles", () => {
  it("stamps the provider/type names onto the declaration", async () => {
    const db = makeDb([[{ typeName: "Fatura", providerName: "House Living" }]]);
    const roles = await resolveRoles(db as unknown as DbLike, TENANT, [
      { key: "faturas", documentTypeId: TYPE_ID, cardinality: "many", required: true },
    ]);
    expect(roles[0]).toEqual(ROLE);
  });

  it("refuses a document type the caller does not own", async () => {
    const db = makeDb([[]]);
    await expect(
      resolveRoles(db as unknown as DbLike, TENANT, [
        { key: "faturas", documentTypeId: TYPE_ID, cardinality: "many", required: true },
      ]),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("refuses two roles with the same key — the context is keyed by it", async () => {
    const db = makeDb([]);
    await expect(
      resolveRoles(db as unknown as DbLike, TENANT, [
        { key: "faturas", documentTypeId: TYPE_ID, cardinality: "many", required: true },
        { key: "faturas", documentTypeId: TYPE_ID, cardinality: "one", required: false },
      ]),
    ).rejects.toThrowError(/duplicado/u);
  });
});

describe("loadFixtureBindings", () => {
  it("gives a `many` role TWO copies of the one fixture", async () => {
    // One row makes an {{#each}} render and hides every mistake that only
    // shows up with more than one row.
    const db = makeDb([[{ id: "e1", data: FIXTURE_DATA }]]);
    const out = await loadFixtureBindings(db as unknown as DbLike, TENANT, [ROLE]);
    expect(out.bindings[0]?.extractions).toHaveLength(2);
    expect(out.rolesWithoutFixture).toEqual([]);
  });

  it("reports a role whose type has no confirmed sample", async () => {
    const db = makeDb([[]]);
    const out = await loadFixtureBindings(db as unknown as DbLike, TENANT, [ROLE]);
    expect(out.rolesWithoutFixture).toEqual(["faturas"]);
    expect(out.bindings[0]?.extractions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

const FIXTURES = {
  bindings: [{ roleKey: "faturas", extractions: [{ id: "e1", data: FIXTURE_DATA }] }],
  rolesWithoutFixture: [] as string[],
};

describe("validateTemplate", () => {
  it("derives slots_json from the HTML, not from what the client claimed", () => {
    const out = validateTemplate({
      html: `{{faturas.length}}{{ai "notas"}}{{ai "fecho"}}`,
      guidelines: [{ slug: "notas", guideline: "Escreva as notas.", maxWords: 120 }],
      roles: [ROLE],
      fixtures: FIXTURES,
      title: "t",
    });
    expect(out.slots).toEqual([
      { slug: "notas", guideline: "Escreva as notas.", maxWords: 120 },
      // Declared by being used; the author simply has not written its
      // guideline yet.
      { slug: "fecho", guideline: "", maxWords: 180 },
    ]);
  });

  it("refuses a guideline for a slot that is not in the HTML", () => {
    // Silently dropping it would let an author write instructions hop 2 never
    // receives, surfacing weeks later as bland prose.
    expect(() =>
      validateTemplate({
        html: `{{ai "notas"}}`,
        guidelines: [{ slug: "inexistente", guideline: "x", maxWords: 120 }],
        roles: [ROLE],
        fixtures: FIXTURES,
        title: "t",
      }),
    ).toThrowError(/não corresponde a nenhum/u);
  });

  it("rejects a §12.4 violation as an author error, not a crash", () => {
    let caught: unknown;
    try {
      validateTemplate({
        html: `{{{faturas}}}`,
        guidelines: [],
        roles: [ROLE],
        fixtures: FIXTURES,
        title: "t",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: "BAD_REQUEST" });
  });

  it("FAILS THE DRY RUN when the template names a field the fixture does not have", () => {
    // The whole reason the dry run exists: the §12.4 gate passes this template
    // happily. Strict mode would only discover it on the first real report, by
    // which time the version is immutable and a draft may point at it.
    let caught: unknown;
    try {
      validateTemplate({
        html: `{{#each faturas}}{{numero_inexistente}}{{/each}}`,
        guidelines: [],
        roles: [ROLE],
        fixtures: FIXTURES,
        title: "t",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: "BAD_REQUEST" });
    expect((caught as { message: string }).message).toMatch(/não renderiza com a amostra/u);
  });

  it("SKIPS the dry run — and says so — when a role has no confirmed sample", () => {
    // A template is authored before the documents it will read exist.
    // Refusing here would make authoring depend on calibration order.
    const out = validateTemplate({
      html: `{{#each faturas}}{{qualquer_coisa}}{{/each}}`,
      guidelines: [],
      roles: [ROLE],
      fixtures: {
        bindings: [{ roleKey: "faturas", extractions: [] }],
        rolesWithoutFixture: ["faturas"],
      },
      title: "t",
    });
    expect(out.dryRun).toMatchObject({ status: "skipped" });
    expect(out.renderedHtml).toBeNull();
  });

  it("still runs the §12.4 gate when the dry run is skipped", () => {
    expect(() =>
      validateTemplate({
        html: `{{{faturas}}}`,
        guidelines: [],
        roles: [ROLE],
        fixtures: { bindings: [], rolesWithoutFixture: ["faturas"] },
        title: "t",
      }),
    ).toThrowError(/triple-stache/u);
  });
});

// ---------------------------------------------------------------------------

describe("saveVersion", () => {
  const INPUT = {
    templateId: TEMPLATE_ID,
    html: `<p>{{faturas.length}}</p>{{ai "notas"}}`,
    inputs: [
      { key: "faturas", documentTypeId: TYPE_ID, cardinality: "many" as const, required: true },
    ],
    slots: [{ slug: "notas", guideline: "g", maxWords: 100 }],
  };

  function primeDb() {
    return makeDb([
      [{ typeName: "Fatura", providerName: "House Living" }], // resolveRoles
      [{ id: "e1", data: FIXTURE_DATA }], // loadFixture
    ]);
  }

  it("INSERTS the next version and never updates one (§5.3)", async () => {
    access.getOutboundTemplate.mockResolvedValue({ id: TEMPLATE_ID, tenantId: TENANT, name: "T" });
    access.insertTemplateVersion.mockResolvedValue({ id: "v-2", version: 2 });

    const out = await saveVersion(primeDb() as unknown as DbLike, CTX, INPUT);

    expect(out).toMatchObject({ versionId: "v-2", version: 2 });
    expect(access.insertTemplateVersion).toHaveBeenCalledWith(
      expect.anything(),
      CTX,
      expect.objectContaining({
        outboundTemplateId: TEMPLATE_ID,
        html: INPUT.html,
        slotsJson: [{ slug: "notas", guideline: "g", maxWords: 100 }],
        inputsJson: [ROLE],
      }),
    );
    // There is no update path in this service at all — that absence IS the
    // immutability guarantee, so assert the module exposes nothing like one.
    const mod = await import("./outbound-template-service");
    expect(Object.keys(mod).some((k) => /update|patch|editVersion/iu.test(k))).toBe(false);
  });

  it("refuses to edit a SYSTEM template from a tenant procedure", async () => {
    access.getOutboundTemplate.mockResolvedValue({ id: TEMPLATE_ID, tenantId: null, name: "T" });
    await expect(saveVersion(primeDb() as unknown as DbLike, CTX, INPUT)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(access.insertTemplateVersion).not.toHaveBeenCalled();
  });

  it("does not write a version that failed the fixture dry run", async () => {
    access.getOutboundTemplate.mockResolvedValue({ id: TEMPLATE_ID, tenantId: TENANT, name: "T" });
    await expect(
      saveVersion(primeDb() as unknown as DbLike, CTX, {
        ...INPUT,
        html: `{{#each faturas}}{{nao_existe}}{{/each}}`,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(access.insertTemplateVersion).not.toHaveBeenCalled();
  });

  it("reports a template the caller cannot see as not found", async () => {
    access.getOutboundTemplate.mockResolvedValue(undefined);
    await expect(saveVersion(primeDb() as unknown as DbLike, CTX, INPUT)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});
