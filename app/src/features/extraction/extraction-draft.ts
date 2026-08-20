// app/src/features/extraction/extraction-draft.ts
//
// The editable shape behind the `revisar` screen (decisions §4.2), and the two
// conversions that bracket it.
//
// WHY THE DRAFT IS ALL STRINGS. The screen edits text inputs; the frozen field
// list says some of those fields are `integer`/`decimal` numbers. Keeping the
// draft typed would mean deciding, on every keystroke, what `"12,"` is — and
// the honest answers ("not a number yet", "not a number ever") are both worse
// than not deciding. So the draft holds exactly what the human typed, and
// `draftToData` converts ONCE, at the boundary, where a value that will not
// convert simply arrives at the validator as a string and gets flagged
// `formato inválido` next to the field it belongs to.
//
// MONEY NEVER CONVERTS AT ALL. §3.1 keeps currency VERBATIM as printed — the
// string IS the value, and parsing it to a number here would reintroduce
// exactly the lost cent that decision exists to prevent.
//
// EVERY KEY IS ALWAYS PRESENT. `fieldsToJsonSchema` marks every field
// required and expresses "optional" as a `null` union, and the runtime Zod
// schema (`buildZodSchema`) uses `strictObject`, where an ABSENT key is not
// the same as a null one. So an emptied optional field is written as `null`,
// never dropped — a screen that silently omitted it would produce a payload
// the validator refuses for a reason the human cannot see.

import type { FieldSpec } from "@shared/validation/field-spec";

/** A leaf's value, exactly as typed. `""` means "no value" — it becomes
 * `null` on the way out (and fails validation when the field is required,
 * which is the point). */
export type LeafDraft = string;

export interface ObjectDraft {
  readonly [name: string]: DraftValue;
}

export type DraftValue = LeafDraft | ObjectDraft | readonly ObjectDraft[];

function isLeafValue(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

/** An empty row of an `object[]`, for [+ Linha]. */
export function emptyRow(fields: readonly FieldSpec[]): ObjectDraft {
  const row: Record<string, DraftValue> = {};
  for (const field of fields) {
    row[field.name] = blankFor(field);
  }
  return row;
}

function blankFor(field: FieldSpec): DraftValue {
  if (field.type === "object") {
    return emptyRow(field.fields ?? []);
  }
  if (field.type === "object[]") {
    return [];
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The extraction payload → the editable draft, driven by the FROZEN LIST and
 * not by the payload's own keys.
 *
 * That direction matters: §4.2's screen must show "every value" of the field
 * list, including the ones the model failed to return — a missing required
 * field is precisely what the human is here to fill in, and iterating the
 * payload would render every field except the broken ones. A key the payload
 * carries that the list does not is dropped here and reported separately as
 * `campo inesperado` by the validator.
 */
export function dataToDraft(fields: readonly FieldSpec[], data: unknown): ObjectDraft {
  const source = asRecord(data);
  const draft: Record<string, DraftValue> = {};
  for (const field of fields) {
    const value = source[field.name];
    if (field.type === "object") {
      draft[field.name] = dataToDraft(field.fields ?? [], value);
      continue;
    }
    if (field.type === "object[]") {
      draft[field.name] = Array.isArray(value)
        ? value.map((row) => dataToDraft(field.fields ?? [], row))
        : [];
      continue;
    }
    draft[field.name] = isLeafValue(value) ? String(value) : "";
  }
  return draft;
}

/**
 * `"1234,5"` → `1234.5`, or the original string when it is not a number.
 *
 * Returning the STRING on failure is deliberate: the alternative is `NaN`
 * (which JSON serialises to `null` and would read as "ausente" rather than
 * "inválido") or a silent `0`. A string reaches `buildZodSchema`'s
 * `z.number()` and comes back as one clearly-placed `formato inválido`.
 *
 * The comma is accepted as a decimal separator because the humans using this
 * screen read pt-BR/pt-PT documents all day; the dot is accepted because they
 * also use a keyboard.
 */
function toNumber(raw: string): number | string {
  const normalized = raw.trim().replace(",", ".");
  const parsed = Number(normalized);
  return normalized.length > 0 && Number.isFinite(parsed) ? parsed : raw.trim();
}

function leafToData(field: FieldSpec, raw: LeafDraft): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (field.type === "integer" || field.type === "decimal") {
    return toNumber(trimmed);
  }
  // string / money / date — verbatim (§3.1).
  return trimmed;
}

/** The draft → the payload `extractions.correct` validates and stores. */
export function draftToData(
  fields: readonly FieldSpec[],
  draft: ObjectDraft,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const field of fields) {
    const value = draft[field.name];
    if (field.type === "object") {
      data[field.name] = draftToData(field.fields ?? [], asDraftObject(value));
      continue;
    }
    if (field.type === "object[]") {
      const rows: readonly ObjectDraft[] = Array.isArray(value) ? value : [];
      data[field.name] = rows.map((row) => draftToData(field.fields ?? [], row));
      continue;
    }
    data[field.name] = leafToData(field, typeof value === "string" ? value : "");
  }
  return data;
}

/** A draft slot read back as an object, or `{}`. Exported because the table
 * needs the SAME narrowing: `Array.isArray` on a `readonly T[]` union does not
 * narrow the other branch in TS, and hand-rolling the check twice is how the
 * two disagree. */
export function asDraftObject(value: DraftValue | undefined): ObjectDraft {
  return typeof value === "object" && !Array.isArray(value) ? (value as ObjectDraft) : {};
}

/** Immutable set of one key on one draft object. The screen's whole mutation
 * surface — nested containers are updated by rebuilding the object above them,
 * which keeps React's identity checks honest without a reducer. */
export function withKey(draft: ObjectDraft, name: string, value: DraftValue): ObjectDraft {
  return { ...draft, [name]: value };
}
