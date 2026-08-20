// shared/validation/job-schemas.ts
//
// Input schema for the jobs router (decisions §4.1). The client polls a ROW,
// never an S3 key: it names the `report_jobs.id` it was handed when the work
// was started, and nothing else. A key-shaped input here would put the client
// back in the business of naming objects, which §12.5 spent a whole amendment
// getting rid of.

import { z } from "zod/v4";

export const PollJobInput = z.object({
  id: z.string().uuid(),
});

export type PollJobInputT = z.infer<typeof PollJobInput>;
