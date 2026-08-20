import { z } from "zod/v4";

const BUSINESS_NAME = z.string().trim().min(2).max(120);
const INDUSTRY = z.string().trim().min(1).max(40).default("restaurant");
const PERSON_NAME = z.string().trim().min(1).max(60);

// Email + name are passed through from step 1 of the signup form so the
// backend can defensively upsert the local users row when the user.created
// webhook hasn't landed yet (race during signup). The Clerk session is the
// authority on identity — JWT.sub is what we trust; these fields only seed
// the optional columns.
export const CreateTenantInput = z.object({
  businessName: BUSINESS_NAME,
  industry: INDUSTRY,
  email: z.string().trim().email().max(320),
  firstName: PERSON_NAME,
  lastName: PERSON_NAME,
});

export const CreateCustomerInput = z.object({
  email: z.string().trim().email().max(320),
  firstName: PERSON_NAME,
  lastName: PERSON_NAME,
  businessName: BUSINESS_NAME,
  industry: INDUSTRY,
});
