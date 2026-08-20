// shared/validation/index.ts
//
// Barrel export for Zod schemas shared between the frontend (forms) and the
// backend (tRPC input validation). One file per domain — both sides import
// from a single source of truth.

export { slugify } from "./slugify";

export {
  TenantValueKindZ,
  CreateTenantValueInput,
  UpdateTenantValueInput,
  TenantValuesListInput,
} from "./tenant-value-schemas";

export { ConfirmUploadInput } from "./document-schemas";

export {
  FIELD_TYPES,
  LEAF_FIELD_TYPES,
  INPUT_MODES,
  MONEY_RE,
  DATE_RE,
  isContainerType,
  isFieldType,
  isInputMode,
  buildZodSchema,
  buildFieldTree,
  flattenFieldTree,
  fieldsToPrompt,
  fieldsToJsonSchema,
} from "./field-spec";
export type {
  FieldType,
  LeafFieldType,
  InputMode,
  FieldSpec,
  FlatFieldRow,
  FlatFieldSpec,
} from "./field-spec";

export {
  PROBLEM_LABEL,
  pathKey,
  problemsAt,
  valueAtPath,
  findFieldSpec,
  parseMoneyToCents,
  validateExtraction,
} from "./extraction-validation";
export type { ProblemCode, FieldProblem, ExtractionValidation } from "./extraction-validation";

export {
  StartExtractionInput,
  GetExtractionInput,
  CorrectExtractionInput,
} from "./extraction-schemas";
export type {
  StartExtractionInputT,
  GetExtractionInputT,
  CorrectExtractionInputT,
} from "./extraction-schemas";

export {
  FieldTypeZ,
  LeafFieldTypeZ,
  InputModeZ,
  FieldNameZ,
  FieldDescriptionZ,
  ChildFieldInput,
  FieldSpecInput,
  FieldListInput,
  DetectHintInput,
  ProposeCalibrationInput,
  PollProposalInput,
  FreezeCalibrationInput,
  GetTemplateInput,
  CalibrationProposalZ,
} from "./calibration-schemas";
