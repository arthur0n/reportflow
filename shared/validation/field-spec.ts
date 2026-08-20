// shared/validation/field-spec.ts
//
// §3.1's freeze, in code — ported from poc/fields/spec.ts, which proved it
// against real documents. The field list is DATA, never a hand-written Zod
// schema: the validator is BUILT AT RUNTIME from it, so "AI proposes → human
// edits → frozen → runs unattended" (§4) has something to freeze.
//
// WHY THIS LIVES IN shared/ AND NOT IN api/lib/. The Calibrate authoring UI
// renders the field list as an editable table: it needs the type vocabulary
// (`FIELD_TYPES`) for its dropdown, the leaf/container split to decide which
// rows may take children, and the exact same `FieldSpec` shape it will send
// back to `calibration.freeze`. A copy in the app is a second statement of
// the vocabulary and would drift from the DB CHECK constraint the moment one
// side gains a type. Everything here is pure TypeScript + Zod — no node
// built-ins, no drizzle — so it bundles into the browser as-is.
//
// DELTA FROM THE POC: `zod/v4` (this repo's import convention) instead of
// bare `zod`, plus the flat↔tree conversion the POC never needed. The POC's
// field lists are hand-written literals; here they are `extract_fields` rows
// carrying `parent_field_id`, and a flat list cannot express `itens[].total`.

import { z } from "zod/v4";

// ---------------------------------------------------------------------------
// Vocabulary. Kept in lockstep with the `extract_fields_type_check` CHECK
// constraint in drizzle/tables/calibration.ts — change both or neither.
// ---------------------------------------------------------------------------

/** `money` is currency kept VERBATIM as printed. Never a float — see MONEY_RE. */
export const FIELD_TYPES = [
  "string",
  "money",
  "date",
  "integer",
  "decimal",
  "object",
  "object[]",
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

/** The types that hold a value rather than other fields. A CHILD field may
 * only be one of these: the authoring UI offers exactly one level of nesting
 * (`itens[]` → `total`), and a container with no children builds an empty
 * `z.strictObject({})` that rejects every document. */
export const LEAF_FIELD_TYPES = ["string", "money", "date", "integer", "decimal"] as const;

export type LeafFieldType = (typeof LEAF_FIELD_TYPES)[number];

/** `object` / `object[]` — the two types whose `fields` are meaningful. */
export function isContainerType(type: FieldType): boolean {
  return type === "object" || type === "object[]";
}

export function isFieldType(value: string): value is FieldType {
  return (FIELD_TYPES as readonly string[]).includes(value);
}

/** A COST decision, not a capability one (§3.1). */
export const INPUT_MODES = ["text", "vision"] as const;
export type InputMode = (typeof INPUT_MODES)[number];

export function isInputMode(value: string): value is InputMode {
  return (INPUT_MODES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The list itself
// ---------------------------------------------------------------------------

export interface FieldSpec {
  /** ordered — §3.1 */
  readonly name: string;
  readonly type: FieldType;
  readonly required: boolean;
  /** What the model reads to RE-FIND the label after a layout nudge. Not an
   * anchor, not an opaque prompt (§3.1). */
  readonly description: string;
  /**
   * Present only for `object` / `object[]`.
   *
   * `| undefined` is explicit even under `exactOptionalPropertyTypes`: this
   * type is the meeting point of a Zod-inferred input (where an optional array
   * IS `T[] | undefined`), a row tree built here, and a React editor's state.
   * Forcing the other two to drop the key entirely buys nothing and costs a
   * cast at every boundary.
   */
  readonly fields?: readonly FieldSpec[] | undefined;
}

/* ------------------------------------------------------------------ */
/* Runtime Zod construction — the whole point of §3.1                  */
/* ------------------------------------------------------------------ */

/**
 * Portuguese/EU currency exactly as printed. We validate the SHAPE and keep
 * the STRING; parsing to cents is a separate deterministic step, so a model
 * can never hand us a float that lost a cent.
 *
 * The tolerated renderings are not a guess — they are what the POC corpus
 * actually contains, and widening this was a REAL CALIBRATION FIX: v1
 * accepted only the invoice typography and rejected the contract, which
 * prints the same amount in the spaced, spelled-out form. The model was right
 * and the field list was wrong — precisely what Calibrate's human step exists
 * for.
 */
export const MONEY_RE =
  /^-?\d{1,3}(?:[.\u00a0\u202f\u2009 ]\d{3})*,\d{2}(?:\s*(?:\u20ac|euros?))?$/u;

export const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/u;

function leafSchema(field: FieldSpec): z.ZodType {
  switch (field.type) {
    case "string":
      return z.string().min(1);
    case "money":
      return z
        .string()
        .regex(MONEY_RE, `${field.name}: esperado valor monetário verbatim, ex.: "1.234,56 €"`);
    case "date":
      return z.string().regex(DATE_RE, `${field.name}: esperado dd/mm/aaaa`);
    case "integer":
      return z.number().int();
    case "decimal":
      return z.number();
    case "object":
      return buildZodSchema(field.fields ?? []);
    case "object[]":
      return z.array(buildZodSchema(field.fields ?? []));
  }
}

/**
 * Build a Zod object schema from a frozen field list, at runtime.
 *
 * `strictObject`: a model inventing a field is a SIGNAL, not something to
 * swallow. §4.2 parks the extraction for `revisar` rather than silently
 * dropping the surprise.
 */
export function buildZodSchema(fields: readonly FieldSpec[]): z.ZodType {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    const base = leafSchema(field);
    shape[field.name] = field.required ? base : base.nullable();
  }
  return z.strictObject(shape);
}

/* ------------------------------------------------------------------ */
/* Field list → prompt fragment. The model sees the same list Zod does. */
/* ------------------------------------------------------------------ */

export function fieldsToPrompt(fields: readonly FieldSpec[], indent = ""): string {
  return fields
    .map((f) => {
      const optionality = f.required ? "obrigatório" : "opcional — use null se ausente";
      const head = `${indent}- ${f.name} (${f.type}, ${optionality}): ${f.description}`;
      return f.fields === undefined
        ? head
        : `${head}\n${fieldsToPrompt(f.fields, `${indent}    `)}`;
    })
    .join("\n");
}

/**
 * JSON Schema for the relay job's `schema` field — derived from the SAME list
 * Zod is built from. Provider-neutral on purpose (§6): each relay adapter
 * translates it into its own dialect (relay/src/providers/gemini.ts turns the
 * `["string","null"]` union into `nullable: true`).
 */
export function fieldsToJsonSchema(fields: readonly FieldSpec[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const f of fields) {
    properties[f.name] = fieldToJsonSchema(f);
  }
  return {
    type: "object",
    properties,
    required: fields.map((f) => f.name),
    additionalProperties: false,
  };
}

function coreJsonSchema(f: FieldSpec): Record<string, unknown> {
  switch (f.type) {
    case "string":
      return { type: "string" };
    case "money":
      return { type: "string", description: 'verbatim, ex.: "1.234,56 €"' };
    case "date":
      return { type: "string", description: "dd/mm/aaaa" };
    case "integer":
      return { type: "integer" };
    case "decimal":
      return { type: "number" };
    case "object":
      return fieldsToJsonSchema(f.fields ?? []);
    case "object[]":
      return { type: "array", items: fieldsToJsonSchema(f.fields ?? []) };
  }
}

function fieldToJsonSchema(f: FieldSpec): Record<string, unknown> {
  const core = coreJsonSchema(f);
  const inner = typeof core["description"] === "string" ? ` — ${core["description"]}` : "";
  const withDesc = { ...core, description: `${f.description}${inner}` };
  // A union type is how "optional" survives into a provider-neutral schema;
  // the adapter turns it into whatever its own dialect calls nullable.
  return f.required ? withDesc : { ...withDesc, type: [core["type"], "null"] };
}

/* ------------------------------------------------------------------ */
/* Flat ↔ tree. `extract_fields` rows carry `parent_field_id`; the list */
/* the model, Zod and the UI all read is a tree.                        */
/* ------------------------------------------------------------------ */

/** The shape of an `extract_fields` row this module needs. Deliberately not
 * `typeof extractFields.$inferSelect` — shared/ must not import drizzle. */
export interface FlatFieldRow {
  readonly id: string;
  readonly parentFieldId: string | null;
  readonly name: string;
  /** `varchar` out of the database; validated against FIELD_TYPES here. */
  readonly type: string;
  readonly required: boolean;
  readonly description: string | null;
  readonly sortOrder: number;
}

/**
 * `extract_fields` rows → the ordered tree. Rows are grouped by
 * `parent_field_id` and each level is sorted by `sort_order`, so the list the
 * extractor prompt shows and the list Zod validates are in the frozen order
 * (§3.1, "ordered").
 *
 * Throws on a type the vocabulary does not contain. The DB CHECK constraint
 * already forbids one, so reaching this is a schema/code disagreement — a
 * dev-time crash, the same call this codebase makes for an unregistered
 * TABLE_SCOPE entry (§12.9), not a silently dropped field.
 */
export function buildFieldTree(rows: readonly FlatFieldRow[]): FieldSpec[] {
  const byParent = new Map<string | null, FlatFieldRow[]>();
  for (const row of rows) {
    const siblings = byParent.get(row.parentFieldId);
    if (siblings === undefined) {
      byParent.set(row.parentFieldId, [row]);
    } else {
      siblings.push(row);
    }
  }

  const build = (parentId: string | null): FieldSpec[] =>
    [...(byParent.get(parentId) ?? [])]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((row) => {
        if (!isFieldType(row.type)) {
          throw new Error(`buildFieldTree: unknown field type "${row.type}" on field ${row.id}`);
        }
        const children = build(row.id);
        return {
          name: row.name,
          type: row.type,
          required: row.required,
          description: row.description ?? "",
          ...(children.length > 0 ? { fields: children } : {}),
        };
      });

  return build(null);
}

/** One node of a tree flattened for INSERT. `key`/`parentKey` are positional
 * paths, not ids: the rows do not exist yet, so the inserter walks this list
 * in order and maps each `key` to the uuid Postgres just handed back. */
export interface FlatFieldSpec {
  /** Dotted path from the root, e.g. `itens.total`. Unique within a list. */
  readonly key: string;
  readonly parentKey: string | null;
  readonly name: string;
  readonly type: FieldType;
  readonly required: boolean;
  readonly description: string;
  /** Position among its own siblings. */
  readonly sortOrder: number;
}

/**
 * The tree → a pre-order flat list, PARENTS ALWAYS BEFORE THEIR CHILDREN.
 * That ordering is the contract: an inserter can walk this once, resolving
 * `parentKey` against ids it has already collected, without a second pass.
 */
export function flattenFieldTree(fields: readonly FieldSpec[]): FlatFieldSpec[] {
  const out: FlatFieldSpec[] = [];
  const walk = (nodes: readonly FieldSpec[], parentKey: string | null, prefix: string): void => {
    nodes.forEach((node, index) => {
      const key = `${prefix}${node.name}`;
      out.push({
        key,
        parentKey,
        name: node.name,
        type: node.type,
        required: node.required,
        description: node.description,
        sortOrder: index,
      });
      if (node.fields !== undefined) {
        walk(node.fields, key, `${key}.`);
      }
    });
  };
  walk(fields, null, "");
  return out;
}
