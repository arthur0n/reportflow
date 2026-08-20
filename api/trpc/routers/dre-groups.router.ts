// api/trpc/routers/dre-groups.router.ts
//
// Read-only facade over the system DRE_GROUP rows in list_of_values.
// Seeded by scripts/seed.ts.

import { router, protectedProcedure } from "../procedures";

const DRE_GROUP_TYPE = "DRE_GROUP";

export const dreGroupsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.lov.list({ type: DRE_GROUP_TYPE, mode: "system" });
    return rows
      .map((r) => ({
        id: r.id,
        code: r.code,
        label: r.value,
        description: r.description,
        sortOrder: r.sortOrder,
      }))
      .sort((a, b) => {
        const so = (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
        if (so !== 0) return so;
        return a.code.localeCompare(b.code);
      });
  }),
});
