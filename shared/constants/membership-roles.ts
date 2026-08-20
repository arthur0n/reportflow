// Numeric role ranks for memberships. Lower = more authority.
// The DB column is plain integer (no CHECK on specific values) so new ranks
// slot in without migrations — just add an LOV row + a constant here.
//
// Authority checks: `ctx.role <= MEMBERSHIP_RANK.REPORTFLOW` not string match.
//
// Reserved ranks not yet used by code (will land when granular access does):
//   10 = MANAGER
//   20 = OPERATOR
// Display labels (incl. translations) live in LOV `type='MEMBERSHIP_ROLE'`,
// keyed by `code = String(rank)`.

export const MEMBERSHIP_RANK = {
  /** ReportFlow staff. Gates the admin menu and system-catalog procedures. */
  REPORTFLOW: 0,
  /** Tenant admin. The default rank for a signup-created membership. */
  ADMIN: 1,
} as const;

export type MembershipRank = (typeof MEMBERSHIP_RANK)[keyof typeof MEMBERSHIP_RANK];
