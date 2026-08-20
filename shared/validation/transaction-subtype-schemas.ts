import { z } from "zod/v4";

export const CreateTransactionSubtypeInput = z.object({
  name: z.string().trim().min(1).max(200),
});
