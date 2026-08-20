// shared/validation/document-schemas.ts
//
// Zod input schemas for the documents router (decisions §8, §12.5). The
// upload path never lets the client name the S3 key: the server mints it
// (api/lib/storage.ts) and hands it back from `presignUpload`. `confirmUpload`
// only accepts the key it already gave out, plus the optional links a
// document may carry once it exists.

import { z } from "zod/v4";

export const ConfirmUploadInput = z.object({
  key: z.string().trim().min(1).max(1024),
  clientId: z.string().uuid().optional(),
  documentTypeId: z.string().uuid().optional(),
});

export type ConfirmUploadInputT = z.infer<typeof ConfirmUploadInput>;
