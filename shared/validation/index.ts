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

export {
  IDENTIFIER_RE,
  RESERVED_ROLE_KEYS,
  RoleKeyZ,
  CardinalityZ,
  RoleInputZ,
  RoleDeclarationZ,
  RoleDeclarationsZ,
  SlotInputZ,
  SlotDeclarationZ,
  SlotDeclarationsZ,
  TEMPLATE_HTML_MAX,
  CreateOutboundTemplateInput,
  OutboundTemplateIdInput,
  SaveTemplateVersionInput,
  PreviewTemplateInput,
} from "./outbound-schemas";
export type {
  Cardinality,
  RoleInputT,
  RoleDeclarationT,
  SlotInputT,
  SlotDeclarationT,
  CreateOutboundTemplateInputT,
  OutboundTemplateIdInputT,
  SaveTemplateVersionInputT,
  PreviewTemplateInputT,
} from "./outbound-schemas";

export {
  CreateReportInput,
  ReportIdInput,
  AttachDocumentInput,
  DetachDocumentInput,
  RoleOptionsInput,
  UpdateSlotInput,
  UpgradeReportVersionInput,
  StartAnalysisInput,
  StartVerifyInput,
} from "./report-schemas";
export type {
  CreateReportInputT,
  ReportIdInputT,
  AttachDocumentInputT,
  DetachDocumentInputT,
  RoleOptionsInputT,
  UpdateSlotInputT,
  UpgradeReportVersionInputT,
  StartAnalysisInputT,
  StartVerifyInputT,
} from "./report-schemas";

export {
  VERDICTS,
  VerdictZ,
  FieldVerdictZ,
  ClaimVerdictZ,
  ExtractionVerdictsZ,
  AnalysisVerdictsZ,
  tallyVerdicts,
} from "./verify-schemas";
export type {
  Verdict,
  FieldVerdictT,
  ClaimVerdictT,
  ExtractionVerdictsT,
  AnalysisVerdictsT,
  VerdictTally,
} from "./verify-schemas";
