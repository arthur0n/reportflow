// shared/validation/detection-schemas.ts
//
// Zod input schemas for document type detection (decisions §3.3, §12.2). All
// three ids are server-issued uuids the client only ever echoes back — none
// of these inputs let the client name anything new.

import { z } from "zod/v4";

export const DetectInput = z.object({
  documentId: z.string().uuid(),
});
export type DetectInputT = z.infer<typeof DetectInput>;

export const ApplyDetectionInput = z.object({
  jobId: z.string().uuid(),
});
export type ApplyDetectionInputT = z.infer<typeof ApplyDetectionInput>;

export const SetDocumentTypeInput = z.object({
  documentId: z.string().uuid(),
  documentTypeId: z.string().uuid(),
});
export type SetDocumentTypeInputT = z.infer<typeof SetDocumentTypeInput>;
