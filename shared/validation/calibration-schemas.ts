// shared/validation/calibration-schemas.ts
//
// Zod for the Calibrate slice (decisions §3.1, §3.3, §12.8) — the tRPC inputs
// AND the schema the model's own proposal is validated against.
//
// Two different jobs live in one file on purpose, because they are two halves
// of the same contract:
//
//   * `CalibrationProposalZ` validates what the RELAY brings back. §12.4: a
//     model's JSON is untrusted no matter who called the model. The JSON
//     Schema handed to the provider (api/calibration/propose-job.ts) is a
//     REQUEST, not a guarantee.
//   * `FreezeCalibrationInput` validates what the HUMAN sends back after
//     editing it. Nothing about the proposal is trusted through the round
//     trip either — the browser is not a trust boundary, and the frozen list
//     is what every later extraction is validated against.
//
// The field vocabulary itself is NOT restated here: it comes from
// ./field-spec.ts, so the CHECK constraint, the runtime Zod builder, the
// authoring UI and these schemas all read one list.

import { z } from "zod/v4";
import { FIELD_TYPES, INPUT_MODES, LEAF_FIELD_TYPES, isContainerType } from "./field-spec";

export const FieldTypeZ = z.enum(FIELD_TYPES);
export const LeafFieldTypeZ = z.enum(LEAF_FIELD_TYPES);
export const InputModeZ = z.enum(INPUT_MODES);

/**
 * A field name has to survive three consumers: a JSON key, a Handlebars path
 * segment (`{{nota.titular.nome}}` — §3.2), and `extract_fields.name`
 * varchar(80). An identifier is the intersection of all three.
 */
/** JS meta-properties: as object keys they corrupt or diverge the runtime
 * schema (`__proto__` doesn't even assign as a normal key), so they are
 * refused outright rather than handled with null-prototype maps everywhere. */
const FORBIDDEN_FIELD_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export const FieldNameZ = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u, "Use apenas letras, números e _ (começando por letra).")
  .refine((name) => !FORBIDDEN_FIELD_NAMES.has(name), "Nome de campo reservado.");

/** Empty is allowed: a human clearing a description is a choice, not an
 * error. Extraction quality suffers (§3.1 — the description is how the model
 * RE-FINDS the label), which is the human's call to make. */
export const FieldDescriptionZ = z.string().trim().max(1000);

/** A CHILD field. Leaf types only — see LEAF_FIELD_TYPES: the authoring UI
 * offers exactly one level of nesting, and a grandchild would need a UI, a
 * prompt fragment and a Zod branch that nothing in §3.1 asks for. The DB
 * (`parent_field_id` is self-referential) can hold deeper trees; this input
 * simply will not create one. */
export const ChildFieldInput = z.object({
  name: FieldNameZ,
  type: LeafFieldTypeZ,
  required: z.boolean(),
  description: FieldDescriptionZ,
});

export const FieldSpecInput = z
  .object({
    name: FieldNameZ,
    type: FieldTypeZ,
    required: z.boolean(),
    description: FieldDescriptionZ,
    fields: z.array(ChildFieldInput).optional(),
  })
  .refine(
    (f) => !isContainerType(f.type) || (f.fields !== undefined && f.fields.length > 0),
    // An empty container builds `z.strictObject({})`, which rejects every
    // document that has anything inside the object — a field list that can
    // never validate is not a field list.
    { message: "Um campo object/object[] precisa de pelo menos um subcampo.", path: ["fields"] },
  )
  .refine((f) => isContainerType(f.type) || f.fields === undefined, {
    message: "Só campos object/object[] podem ter subcampos.",
    path: ["fields"],
  });

/** Duplicate names break the runtime-built Zod schema silently (the second
 * shape entry wins), which is exactly why the DB carries two partial unique
 * indexes for the same rule. Catch it before the insert does. */
function namesAreUnique(fields: readonly { name: string }[]): boolean {
  return new Set(fields.map((f) => f.name)).size === fields.length;
}

export const FieldListInput = z
  .array(FieldSpecInput)
  .min(1, "Congele pelo menos um campo.")
  .max(120)
  .refine(namesAreUnique, "Dois campos de topo com o mesmo nome.")
  .refine(
    (fields) => fields.every((f) => f.fields === undefined || namesAreUnique(f.fields)),
    "Dois subcampos do mesmo campo com o mesmo nome.",
  );

/** §3.3 tier 1: distinctive substrings present on EVERY document of the type.
 * Capped at five because a hint list is a human-verified claim about every
 * future document, not a corpus. */
export const DetectHintInput = z.array(z.string().trim().min(2).max(200)).max(5);

// ---------------------------------------------------------------------------
// tRPC inputs
// ---------------------------------------------------------------------------

/** Either an existing row this tenant owns, or a name to create. Both are
 * re-proven server-side — a uuid from the client is a lookup key, never a
 * permission (api/services/documents-crud.ts makes the same point). */
export const ProviderRefZ = z.union([
  z.object({ id: z.string().uuid() }),
  z.object({ name: z.string().trim().min(1).max(120) }),
]);

export const DocumentTypeRefZ = z.union([
  z.object({ id: z.string().uuid() }),
  z.object({ name: z.string().trim().min(1).max(120) }),
]);

/**
 * Calibrate proposes from ONE sample document (§3.1, "upload a sample").
 * `providerId` / `documentTypeName` are context for the prompt only — propose
 * writes nothing but the job row.
 */
export const ProposeCalibrationInput = z.object({
  documentId: z.string().uuid(),
  providerId: z.string().uuid().optional(),
  documentTypeName: z.string().trim().min(1).max(120).optional(),
});
export type ProposeCalibrationInputT = z.infer<typeof ProposeCalibrationInput>;

/** `report_jobs.id`, the same row `jobs.poll` reads. */
export const PollProposalInput = z.object({
  jobId: z.string().uuid(),
});
export type PollProposalInputT = z.infer<typeof PollProposalInput>;

export const FreezeCalibrationInput = z.object({
  provider: ProviderRefZ,
  documentType: DocumentTypeRefZ,
  /** The calibration sample. Its `s3_key` becomes `fixture_s3_key` (§3.1). */
  sampleDocumentId: z.string().uuid(),
  inputMode: InputModeZ,
  detectHint: DetectHintInput,
  fields: FieldListInput,
  /**
   * The human-confirmed extraction of the sample — the OTHER half of the
   * golden fixture. Optional: a template can be frozen before anyone has
   * checked the values, and the fixture is then just the PDF.
   */
  confirmedJson: z.record(z.string(), z.unknown()).optional(),
});
export type FreezeCalibrationInputT = z.infer<typeof FreezeCalibrationInput>;

export const GetTemplateInput = z.object({
  templateId: z.string().uuid(),
});
export type GetTemplateInputT = z.infer<typeof GetTemplateInput>;

// ---------------------------------------------------------------------------
// The model's proposal — untrusted input (§12.4)
// ---------------------------------------------------------------------------

const ProposedChildZ = z.object({
  name: FieldNameZ,
  type: LeafFieldTypeZ,
  required: z.boolean(),
  description: FieldDescriptionZ,
});

const ProposedFieldZ = z.object({
  name: FieldNameZ,
  type: FieldTypeZ,
  required: z.boolean(),
  description: FieldDescriptionZ,
  fields: z.array(ProposedChildZ).optional(),
});

/**
 * Deliberately LOOSER than `FreezeCalibrationInput`: this is a DRAFT for a
 * human to edit, so a proposal with an empty `object[]` or a duplicate name
 * must still reach the screen where someone can fix it. Refusing it outright
 * would spend a hop and show nothing. The strict rules apply at `freeze`,
 * which is where the list stops being a draft.
 */
export const CalibrationProposalZ = z.object({
  document_type_name: z.string().trim().min(1).max(120),
  input_mode: InputModeZ,
  detect_hint: z.array(z.string().trim().min(1).max(200)).max(5),
  fields: z.array(ProposedFieldZ).max(120),
  /**
   * The model's own extraction of the sample under the list it just proposed,
   * as a JSON string. A string and not an object because the provider's
   * structured-output schema has to be fixed up front and these keys are
   * whatever the model decides to propose — an object here is not expressible.
   * The API never trusts it: it is parsed, shown in a textarea, edited by a
   * human, and re-validated against the FROZEN list at `freeze` time.
   */
  sample_values_json: z.string().max(200_000).optional(),
});
export type CalibrationProposalT = z.infer<typeof CalibrationProposalZ>;
