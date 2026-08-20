// shared/validation/report-schemas.ts
//
// Report draft + publish wire shapes (decisions §5).
//
// Every id here is a server-issued uuid the client only echoes back. A uuid is
// a LOOKUP KEY, never a permission — api/services/report-service.ts re-proves
// ownership of each one under `ctx.tenantId`, and `template_version_id` goes
// through `assertVersionVisible` (api/db/outbound-access.ts) because a version
// row carries no tenant_id of its own to check against.

import { z } from "zod/v4";
import { RoleKeyZ, IDENTIFIER_RE } from "./outbound-schemas";

export const CreateReportInput = z.object({
  templateVersionId: z.string().uuid(),
  clientId: z.string().uuid().nullish(),
  title: z.string().trim().max(200).nullish(),
});
export type CreateReportInputT = z.infer<typeof CreateReportInput>;

export const ReportIdInput = z.object({ reportId: z.string().uuid() });
export type ReportIdInputT = z.infer<typeof ReportIdInput>;

export const AttachDocumentInput = z.object({
  reportId: z.string().uuid(),
  roleKey: RoleKeyZ,
  extractionId: z.string().uuid(),
});
export type AttachDocumentInputT = z.infer<typeof AttachDocumentInput>;

export const DetachDocumentInput = AttachDocumentInput;
export type DetachDocumentInputT = z.infer<typeof DetachDocumentInput>;

export const RoleOptionsInput = z.object({
  reportId: z.string().uuid(),
  roleKey: RoleKeyZ,
});
export type RoleOptionsInputT = z.infer<typeof RoleOptionsInput>;

/**
 * §5.2 — editing a slot sets `edited: true`, and regeneration skips edited
 * slots by default. The flag is NOT an input: it is what this mutation MEANS,
 * so a client cannot write prose while claiming the model wrote it.
 */
export const UpdateSlotInput = z.object({
  reportId: z.string().uuid(),
  slug: z.string().regex(IDENTIFIER_RE),
  text: z.string().max(20_000),
});
export type UpdateSlotInputT = z.infer<typeof UpdateSlotInput>;

/**
 * §5.3 — "updating a draft to a newer version is explicit, never automatic".
 * The target version is named by the human, which is why it is an input here
 * and not a `latest` flag the server resolves.
 */
export const UpgradeReportVersionInput = z.object({
  reportId: z.string().uuid(),
  templateVersionId: z.string().uuid(),
});
export type UpgradeReportVersionInputT = z.infer<typeof UpgradeReportVersionInput>;
