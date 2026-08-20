import { z } from "zod/v4";

export const CreatePaymentMethodInput = z.object({
  name: z.string().trim().min(1).max(200),
  // Set after the user has seen similarity suggestions and chose to create
  // a new row anyway. Default false → server runs the preflight.
  confirmedDespiteSuggestions: z.boolean().optional(),
});

export const UpdatePaymentMethodInput = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
});

// scope='combined' (default) returns system + tenant rows merged. system rows
// are read-only on the FE; tenant rows are mutable. status='inactive' implies
// tenant scope only — system rows have no inactive concept from a tenant POV.
export const PaymentMethodsListInput = z
  .object({
    status: z.enum(["active", "inactive", "all"]).default("active"),
    scope: z.enum(["tenant", "combined"]).default("combined"),
    search: z.string().trim().max(100).optional(),
  })
  .optional();
