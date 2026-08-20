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

/**
 * §4 hop 2 — the analysis.
 *
 * `slugs` IS the "regerar mesmo assim" override (§5.2), and it is deliberately
 * not accompanied by a boolean. Naming a slot is what forces it: a separate
 * `force: true` could be set for slots the caller never looked at, which is
 * exactly the silent-destruction case §5.2 exists to prevent. Absent or empty
 * means "every slot a human has not edited".
 *
 * 24 is `SaveTemplateVersionInput`'s own cap on slots per version.
 */
export const StartAnalysisInput = z.object({
  reportId: z.string().uuid(),
  slugs: z.array(z.string().regex(IDENTIFIER_RE)).max(24).optional(),
});
export type StartAnalysisInputT = z.infer<typeof StartAnalysisInput>;

/**
 * §12.13 — the adversarial verify, whose two halves audit two different
 * artifacts and therefore name two different ids. A discriminated union rather
 * than two optional uuids: "exactly one of these" is a shape, not a runtime
 * check somebody has to remember to write.
 */
export const StartVerifyInput = z.discriminatedUnion("target", [
  z.object({ target: z.literal("extraction"), extractionId: z.string().uuid() }),
  z.object({ target: z.literal("analysis"), reportId: z.string().uuid() }),
]);
export type StartVerifyInputT = z.infer<typeof StartVerifyInput>;
