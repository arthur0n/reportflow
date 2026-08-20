// api/trpc/routers/onboarding.router.ts
//
// Customer onboarding endpoints. Two modes share the same orchestrator
// (api/services/onboarding.ts):
//
//   createTenant   — verifiedProcedure. Self-service step 3, called after the
//                    user has signed up + verified their email via Clerk's
//                    frontend SDK. Creates the Clerk org mirror + tenant + admin
//                    membership in our DB.
//
//   createCustomer — adminProcedure. ReportFlow staff provisions a tenant for
//                    a new customer end-to-end (provider createUser, org,
//                    DB rows, password-setup ticket URL). Staff hands the URL
//                    to the customer out-of-band.
//
// Both run through adminDb (cross-tenant), with idempotent upserts so a
// concurrent webhook redelivery cannot duplicate rows.

import { router, verifiedProcedure, adminProcedure } from "../procedures";
import { CreateTenantInput, CreateCustomerInput } from "../../../shared/validation";
import { selfServiceCreateTenant, staffCreateCustomer } from "../../services/onboarding";

export const onboardingRouter = router({
  createTenant: verifiedProcedure.input(CreateTenantInput).mutation(async ({ ctx, input }) => {
    const result = await selfServiceCreateTenant({
      externalUserId: ctx.externalUserId,
      email: input.email,
      name: `${input.firstName} ${input.lastName}`.trim(),
      businessName: input.businessName,
      industry: input.industry,
    });
    return { tenantId: result.tenantId };
  }),

  createCustomer: adminProcedure.input(CreateCustomerInput).mutation(async ({ input }) => {
    const result = await staffCreateCustomer({
      email: input.email,
      firstName: input.firstName,
      lastName: input.lastName,
      businessName: input.businessName,
      industry: input.industry,
    });
    return {
      tenantId: result.tenantId,
      inviteUrl: result.inviteUrl,
      inviteExpiresAt: result.inviteExpiresAt,
    };
  }),
});
