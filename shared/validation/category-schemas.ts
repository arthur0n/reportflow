import { z } from "zod/v4";

export const CreateCategoryInput = z.object({
  dreGroupCode: z.string().trim().min(1).max(10),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(500).optional(),
  // Set after the user has seen similarity suggestions and chose to create
  // a new row anyway. Default false → server runs the preflight.
  confirmedDespiteSuggestions: z.boolean().optional(),
});

export const UpdateCategoryInput = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(500).nullable().optional(),
});

export const ReclassifyCategoryInput = z.object({
  id: z.string().uuid(),
  dreGroupCode: z.string().trim().min(1).max(10),
});

export const CategoriesListInput = z
  .object({
    dreGroupCode: z.string().trim().min(1).max(10).optional(),
    status: z.enum(["active", "inactive", "all"]).default("active"),
    search: z.string().trim().max(100).optional(),
  })
  .optional();

export const TransactionsCountInput = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
});
