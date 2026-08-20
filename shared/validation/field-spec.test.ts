// shared/validation/field-spec.test.ts
//
// The runtime-Zod builder is the mechanism §3.1 rests on: the frozen field
// list is DATA, and everything downstream — the extractor's schema, the
// validator, the authoring table — is derived from it. A bug here is a bug in
// every extraction at once, so this suite drives the derivation itself rather
// than any caller.
//
// The money cases are not synthetic. They are the two renderings the POC
// corpus actually contains (invoice typography and the contract's spelled-out
// form), and accepting only the first was a real calibration miss.

import { describe, it, expect } from "vitest";
import {
  buildFieldTree,
  buildZodSchema,
  fieldsToJsonSchema,
  fieldsToPrompt,
  flattenFieldTree,
  isContainerType,
  isFieldType,
  isInputMode,
  type FieldSpec,
  type FlatFieldRow,
} from "./field-spec";

const leaf = (name: string, type: FieldSpec["type"], required = true): FieldSpec => ({
  name,
  type,
  required,
  description: `campo ${name}`,
});

describe("buildZodSchema — every type in the vocabulary", () => {
  const fields: FieldSpec[] = [
    leaf("numero", "string"),
    leaf("total", "money"),
    leaf("data", "date"),
    leaf("quantidade", "integer"),
    leaf("taxa", "decimal"),
  ];

  it("accepts a payload that matches the list", () => {
    const parsed = buildZodSchema(fields).safeParse({
      numero: "FT A2024/1",
      total: "1.234,56 €",
      data: "31/12/2024",
      quantidade: 3,
      taxa: 0.23,
    });
    expect(parsed.success).toBe(true);
  });

  // The calibration fix: the contract prints the same amount with a spaced
  // thousands separator and the currency spelled out. The model was right and
  // the field list was wrong.
  it("accepts the spelled-out currency rendering, not just the invoice one", () => {
    const schema = buildZodSchema([leaf("total", "money")]);
    expect(schema.safeParse({ total: "1 234,56 euros" }).success).toBe(true);
    expect(schema.safeParse({ total: "1.234,56 €" }).success).toBe(true);
  });

  // Catches the whole point of `money`: a float has already lost the cent by
  // the time it reaches us, and no later step can recover it.
  it("refuses a money field that arrived as a number", () => {
    expect(buildZodSchema([leaf("total", "money")]).safeParse({ total: 1234.56 }).success).toBe(
      false,
    );
  });

  it("refuses a date that is not dd/mm/aaaa", () => {
    expect(buildZodSchema([leaf("data", "date")]).safeParse({ data: "2024-12-31" }).success).toBe(
      false,
    );
  });

  it("refuses a non-integer where the list says integer", () => {
    expect(
      buildZodSchema([leaf("quantidade", "integer")]).safeParse({ quantidade: 1.5 }).success,
    ).toBe(false);
  });

  it("accepts null only where the list says optional", () => {
    expect(buildZodSchema([leaf("obs", "string", false)]).safeParse({ obs: null }).success).toBe(
      true,
    );
    expect(buildZodSchema([leaf("obs", "string", true)]).safeParse({ obs: null }).success).toBe(
      false,
    );
  });

  // §4.2 — an invented field is a SIGNAL, not something to swallow.
  it("refuses a field the frozen list never asked for", () => {
    const parsed = buildZodSchema([leaf("numero", "string")]).safeParse({
      numero: "1",
      inventado: "x",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("buildZodSchema — nesting", () => {
  const withItems: FieldSpec[] = [
    leaf("numero", "string"),
    {
      name: "itens",
      type: "object[]",
      required: true,
      description: "linhas da fatura",
      fields: [leaf("descricao", "string"), leaf("total", "money")],
    },
  ];

  it("validates each element of an object[] against the child list", () => {
    const schema = buildZodSchema(withItems);
    expect(
      schema.safeParse({
        numero: "1",
        itens: [{ descricao: "a", total: "10,00 €" }],
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({ numero: "1", itens: [{ descricao: "a", total: "dez euros" }] }).success,
    ).toBe(false);
  });

  it("validates a plain object child list too", () => {
    const schema = buildZodSchema([
      {
        name: "titular",
        type: "object",
        required: true,
        description: "adquirente",
        fields: [leaf("nome", "string")],
      },
    ]);
    expect(schema.safeParse({ titular: { nome: "Ana" } }).success).toBe(true);
    expect(schema.safeParse({ titular: {} }).success).toBe(false);
  });
});

describe("fieldsToJsonSchema", () => {
  it("expresses an optional field as a nullable union the relay adapters translate", () => {
    const schema = fieldsToJsonSchema([leaf("obs", "string", false)]);
    const properties = schema["properties"] as Record<string, Record<string, unknown>>;
    expect(properties["obs"]?.["type"]).toEqual(["string", "null"]);
  });

  it("nests an object[] as an array of the child object schema", () => {
    const schema = fieldsToJsonSchema([
      {
        name: "itens",
        type: "object[]",
        required: true,
        description: "linhas",
        fields: [leaf("total", "money")],
      },
    ]);
    const properties = schema["properties"] as Record<string, Record<string, unknown>>;
    const items = properties["itens"]?.["items"] as Record<string, unknown>;
    expect(items["required"]).toEqual(["total"]);
  });
});

describe("fieldsToPrompt", () => {
  it("shows the model the same list, order and optionality Zod enforces", () => {
    const text = fieldsToPrompt([
      leaf("numero", "string"),
      leaf("obs", "string", false),
      {
        name: "itens",
        type: "object[]",
        required: true,
        description: "linhas",
        fields: [leaf("total", "money")],
      },
    ]);
    expect(text.indexOf("numero")).toBeLessThan(text.indexOf("obs"));
    expect(text).toContain("obrigatório");
    expect(text).toContain("use null se ausente");
    expect(text).toContain("    - total");
  });
});

describe("flat ↔ tree", () => {
  const tree: FieldSpec[] = [
    leaf("numero", "string"),
    {
      name: "itens",
      type: "object[]",
      required: true,
      description: "linhas",
      fields: [leaf("descricao", "string"), leaf("total", "money")],
    },
  ];

  // The contract the inserter relies on: it walks this list once, resolving
  // parentKey against ids Postgres has already handed back.
  it("flattens parents before their children, with sibling order preserved", () => {
    const flat = flattenFieldTree(tree);
    expect(flat.map((f) => f.key)).toEqual(["numero", "itens", "itens.descricao", "itens.total"]);
    expect(flat.map((f) => f.parentKey)).toEqual([null, null, "itens", "itens"]);
    expect(flat.map((f) => f.sortOrder)).toEqual([0, 1, 0, 1]);
  });

  it("rebuilds the same tree from extract_fields rows, sorted by sort_order", () => {
    const rows: FlatFieldRow[] = [
      // Deliberately out of order: `sort_order` is the authority, not the row
      // order a query happened to return.
      {
        id: "c2",
        parentFieldId: "p2",
        name: "total",
        type: "money",
        required: true,
        description: "campo total",
        sortOrder: 1,
      },
      {
        id: "p2",
        parentFieldId: null,
        name: "itens",
        type: "object[]",
        required: true,
        description: "linhas",
        sortOrder: 1,
      },
      {
        id: "p1",
        parentFieldId: null,
        name: "numero",
        type: "string",
        required: true,
        description: "campo numero",
        sortOrder: 0,
      },
      {
        id: "c1",
        parentFieldId: "p2",
        name: "descricao",
        type: "string",
        required: true,
        description: "campo descricao",
        sortOrder: 0,
      },
    ];
    expect(buildFieldTree(rows)).toEqual(tree);
  });

  it("round-trips a tree through flatten and back", () => {
    const flat = flattenFieldTree(tree);
    const idByKey = new Map(flat.map((f, i) => [f.key, `id-${String(i)}`]));
    const rows: FlatFieldRow[] = flat.map((f) => ({
      id: idByKey.get(f.key) ?? "",
      parentFieldId: f.parentKey === null ? null : (idByKey.get(f.parentKey) ?? null),
      name: f.name,
      type: f.type,
      required: f.required,
      description: f.description,
      sortOrder: f.sortOrder,
    }));
    expect(buildFieldTree(rows)).toEqual(tree);
  });

  // A type outside the vocabulary can only mean the CHECK constraint and this
  // module disagree. §12.9's call: crash at dev time rather than drop a field.
  it("throws on a row whose type is not in the vocabulary", () => {
    expect(() =>
      buildFieldTree([
        {
          id: "x",
          parentFieldId: null,
          name: "n",
          type: "timestamp",
          required: true,
          description: null,
          sortOrder: 0,
        },
      ]),
    ).toThrow(/timestamp/u);
  });
});

describe("vocabulary guards", () => {
  it("agrees on which types are containers", () => {
    expect(isContainerType("object")).toBe(true);
    expect(isContainerType("object[]")).toBe(true);
    expect(isContainerType("money")).toBe(false);
  });

  it("rejects strings outside the vocabulary", () => {
    expect(isFieldType("money")).toBe(true);
    expect(isFieldType("timestamp")).toBe(false);
    expect(isInputMode("vision")).toBe(true);
    expect(isInputMode("ocr")).toBe(false);
  });
});
