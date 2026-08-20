/**
 * §3.1 — the Calibrate freeze, in code.
 *
 * An extract template is (field list + input_mode + detect_hint), frozen together.
 * The field list is DATA, not a hand-written Zod schema: the Zod validator is
 * BUILT AT RUNTIME from it. In the real pipeline this list comes out of
 * `extract_fields` rows; here it is a hand-written literal standing in for
 * "AI proposes -> human edits -> frozen".
 *
 * Not anchors. Not an opaque prompt. A layout nudge does not break extraction,
 * because the model re-finds the label from `description`.
 */
import { z } from "zod";

export type FieldType =
  | "string"
  | "money" // currency, kept VERBATIM as the string on the page. Never a float.
  | "date" // dd/mm/yyyy as printed
  | "integer"
  | "decimal"
  | "object"
  | "object[]";

export interface FieldSpec {
  /** ordered — §3.1 */
  readonly name: string;
  readonly type: FieldType;
  readonly required: boolean;
  readonly description: string;
  /** present only for `object` / `object[]` */
  readonly fields?: readonly FieldSpec[];
}

export type InputMode = "text" | "vision";

export interface ExtractTemplate {
  /** the document TYPE, not the provider — Calibrate runs per type (§3.1) */
  readonly documentType: string;
  readonly provider: string;
  /** a COST decision, not a capability one (§3.1) */
  readonly inputMode: InputMode;
  /** tier-1 substring detection (§3.3) — distinctive on every doc of this type */
  readonly detectHint: readonly string[];
  readonly fields: readonly FieldSpec[];
  /** §12.8 — recalibration invalidates; this participates in the cache key */
  readonly calibrationRev: number;
}

/* ------------------------------------------------------------------ */
/* Runtime Zod construction — the whole point of §3.1                  */
/* ------------------------------------------------------------------ */

/**
 * Portuguese/EU currency exactly as printed. We validate the SHAPE and keep the
 * STRING; parsing to cents is a separate deterministic step (lib/money.ts), so a
 * model can never hand us a float that lost a cent.
 *
 * The tolerated renderings are not a guess — they are what the corpus actually
 * contains, and widening this was a REAL CALIBRATION FIX. v1 accepted only the
 * invoice typography and rejected the contract, which prints the same amount in the spaced, spelled-out form: space as thousands separator, currency spelled
 * out, the ordinary convention in a Portuguese legal document.
 *
 * The model was right and the field list was wrong. That is precisely the split
 * §4.2 is designed to surface — the extraction was parked for `revisar` rather
 * than silently coerced — and precisely what Calibrate's human step is for.
 */
export const MONEY_RE = /^-?\d{1,3}(?:[.\u00a0\u202f\u2009 ]\d{3})*,\d{2}(?:\s*(?:\u20ac|euros?))?$/u;
export const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/u;

function leafSchema(field: FieldSpec): z.ZodTypeAny {
  switch (field.type) {
    case "string":
      return z.string().min(1);
    case "money":
      return z
        .string()
        .regex(MONEY_RE, `${field.name}: expected verbatim currency like "1.234,56 €"`);
    case "date":
      return z.string().regex(DATE_RE, `${field.name}: expected dd/mm/yyyy`);
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

/** Build a Zod object schema from a frozen field list, at runtime. */
export function buildZodSchema(
  fields: readonly FieldSpec[],
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    const base = leafSchema(field);
    shape[field.name] = field.required ? base : base.nullable();
  }
  // strict(): a model inventing a field is a signal, not something to swallow.
  return z.object(shape).strict();
}

/* ------------------------------------------------------------------ */
/* Compile-time mirror of the same list (DX only; Zod is the authority) */
/* ------------------------------------------------------------------ */

type LeafOf<T extends FieldSpec> = T["type"] extends "string" | "money" | "date"
  ? string
  : T["type"] extends "integer" | "decimal"
    ? number
    : T["type"] extends "object"
      ? InferFields<NonNullable<T["fields"]>>
      : T["type"] extends "object[]"
        ? InferFields<NonNullable<T["fields"]>>[]
        : never;

export type InferFields<T extends readonly FieldSpec[]> = {
  [K in T[number] as K["name"]]: K["required"] extends true ? LeafOf<K> : LeafOf<K> | null;
};

/* ------------------------------------------------------------------ */
/* Field list -> prompt fragment. The model sees the same list Zod does. */
/* ------------------------------------------------------------------ */

export function fieldsToPrompt(fields: readonly FieldSpec[], indent = ""): string {
  return fields
    .map((f) => {
      const head = `${indent}- ${f.name} (${f.type}${f.required ? ", obrigatório" : ", opcional — use null se ausente"}): ${f.description}`;
      return f.fields ? `${head}\n${fieldsToPrompt(f.fields, `${indent}    `)}` : head;
    })
    .join("\n");
}

/** JSON Schema for `output_config.format` — derived from the same list. */
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

function fieldToJsonSchema(f: FieldSpec): Record<string, unknown> {
  const core = ((): Record<string, unknown> => {
    switch (f.type) {
      case "string":
        return { type: "string" };
      case "money":
        return { type: "string", description: 'verbatim, e.g. "1.234,56 €"' };
      case "date":
        return { type: "string", description: "dd/mm/yyyy" };
      case "integer":
        return { type: "integer" };
      case "decimal":
        return { type: "number" };
      case "object":
        return fieldsToJsonSchema(f.fields ?? []);
      case "object[]":
        return { type: "array", items: fieldsToJsonSchema(f.fields ?? []) };
    }
  })();
  const withDesc = {
    ...core,
    description: `${f.description}${"description" in core ? ` — ${String(core["description"])}` : ""}`,
  };
  return f.required ? withDesc : { ...withDesc, type: [core["type"], "null"] };
}
