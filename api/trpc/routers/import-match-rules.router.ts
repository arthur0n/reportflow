// CRUD over import_match_rules.
//
// Two surfaces. Tenant-rule endpoints run on protectedProcedure — any active
// tenant member can manage their own rules, matching the categories /
// payment-methods / tenant-values convention. System-rule endpoints (tenant_id
// IS NULL) stay on adminProcedure (ReportFlow staff only).
//
// Every mutation: validates regex compiles, asserts target FK exists & is
// kind-consistent, caps tenant rule count at 100, writes audit_logs in the
// same tx, and busts the per-Lambda RuleMatcher cache.

import { TRPCError } from "@trpc/server";
import { z } from "zod/v4";
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { router, protectedProcedure, adminProcedure } from "../procedures";
import { db } from "../../db/client";
import { importMatchRules, listOfValues, tenantValues } from "../../../drizzle/schema";
import { withSystemFields } from "../../db/scope";

// import_match_rules is dual-scope (system + tenant) so ctx.db.scope() returns
// sql`true`; tenant endpoints add an explicit tenantId predicate, system
// endpoints (tenantId IS NULL) bypass ctx.db.create which would auto-inject.
import { writeAuditEntry } from "../../services/audit";
import { clearMatchRulesCache } from "../../imports/matcher";
import {
  CreateTenantRuleInput,
  UpdateTenantRuleInput,
  ListTenantRulesInput,
  CreateSystemRuleInput,
  UpdateSystemRuleInput,
  ListSystemRulesInput,
} from "../../../shared/validation/import-match-rule-schemas";

const TENANT_RULES_CAP = 100;
const ENTITY_TYPE = "IMPORT_MATCH_RULE";

type TargetKind = "CATEGORY" | "PAYMENT_METHOD" | "SUPPLIER" | "CUSTOMER" | "SUBTYPE";

function isLovTargetKind(kind: TargetKind): boolean {
  return kind === "CATEGORY" || kind === "PAYMENT_METHOD" || kind === "SUBTYPE";
}

function lovTypeFor(kind: TargetKind): "CATEGORY" | "PAYMENT_METHOD" | "TRANSACTION_SUBTYPE" {
  if (kind === "CATEGORY") return "CATEGORY";
  if (kind === "PAYMENT_METHOD") return "PAYMENT_METHOD";
  if (kind === "SUBTYPE") return "TRANSACTION_SUBTYPE";
  throw new Error(`not an LOV target kind: ${kind}`);
}

function tenantValueKindFor(kind: TargetKind): "SUPPLIER" | "CUSTOMER" {
  if (kind === "SUPPLIER") return "SUPPLIER";
  if (kind === "CUSTOMER") return "CUSTOMER";
  throw new Error(`not a tenant_values target kind: ${kind}`);
}

function assertRegexCompiles(matchKind: string, pattern: string): void {
  if (matchKind !== "regex") return;
  try {
    new RegExp(pattern, "i");
  } catch (err) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

// ──────────────────── Target FK validation ────────────────────

async function assertLovTargetExists(args: {
  targetId: string;
  type: "CATEGORY" | "PAYMENT_METHOD" | "TRANSACTION_SUBTYPE";
  // null = system row only; string = visible to tenant (system + own).
  tenantId: string | null;
}): Promise<void> {
  const conditions = [
    eq(listOfValues.id, args.targetId),
    eq(listOfValues.type, args.type),
    isNull(listOfValues.deletedAt),
  ];
  if (args.tenantId === null) {
    conditions.push(isNull(listOfValues.tenantId));
  }
  const [row] = await db
    .select({ id: listOfValues.id, tenantId: listOfValues.tenantId })
    .from(listOfValues)
    .where(and(...conditions))
    .limit(1);
  if (!row) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `lov target ${args.targetId} not found for type=${args.type}`,
    });
  }
  if (args.tenantId !== null && row.tenantId !== null && row.tenantId !== args.tenantId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "cannot target another tenant's LOV row",
    });
  }
}

async function assertTenantValueTargetExists(args: {
  targetId: string;
  kind: "SUPPLIER" | "CUSTOMER";
  tenantId: string;
}): Promise<void> {
  const [row] = await db
    .select({ id: tenantValues.id })
    .from(tenantValues)
    .where(
      and(
        eq(tenantValues.id, args.targetId),
        eq(tenantValues.tenantId, args.tenantId),
        eq(tenantValues.kind, args.kind),
        isNull(tenantValues.deletedAt),
      ),
    )
    .limit(1);
  if (!row) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `tenant_values target ${args.targetId} not found for kind=${args.kind}`,
    });
  }
}

// Asserts the (lovTargetId, tvTargetId) pair is exactly-one-set and matches
// targetKind. For tenant rules, validates against the tenant's audience.
async function validateTenantRuleTarget(args: {
  targetKind: TargetKind;
  lovTargetId: string | null | undefined;
  tvTargetId: string | null | undefined;
  tenantId: string;
}): Promise<{ lovTargetId: string | null; tvTargetId: string | null }> {
  const isLov = isLovTargetKind(args.targetKind);
  const lov = args.lovTargetId ?? null;
  const tv = args.tvTargetId ?? null;

  if (isLov) {
    if (lov === null || tv !== null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `targetKind=${args.targetKind} requires lovTargetId only`,
      });
    }
    await assertLovTargetExists({
      targetId: lov,
      type: lovTypeFor(args.targetKind),
      tenantId: args.tenantId,
    });
    return { lovTargetId: lov, tvTargetId: null };
  }

  if (tv === null || lov !== null) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `targetKind=${args.targetKind} requires tvTargetId only`,
    });
  }
  await assertTenantValueTargetExists({
    targetId: tv,
    kind: tenantValueKindFor(args.targetKind),
    tenantId: args.tenantId,
  });
  return { lovTargetId: null, tvTargetId: tv };
}

async function assertUnderTenantCap(tenantId: string): Promise<void> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(importMatchRules)
    .where(and(eq(importMatchRules.tenantId, tenantId), isNull(importMatchRules.deletedAt)));
  const current = Number(row?.count ?? 0);
  if (current >= TENANT_RULES_CAP) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `tenant rule cap reached (${TENANT_RULES_CAP})`,
    });
  }
}

// ──────────────────── Tenant CRUD ────────────────────

export const importMatchRulesRouter = router({
  /** List tenant rules. Falls through to the audit log via createdAt desc. */
  list: protectedProcedure.input(ListTenantRulesInput).query(async ({ ctx, input }) => {
    const conditions = [eq(importMatchRules.tenantId, ctx.tenantId)];
    if (input.targetKind !== undefined) {
      conditions.push(eq(importMatchRules.targetKind, input.targetKind));
    }
    if (input.status === "active") conditions.push(isNull(importMatchRules.deletedAt));
    if (input.status === "inactive") conditions.push(isNotNull(importMatchRules.deletedAt));

    return ctx.db.raw
      .select()
      .from(importMatchRules)
      .where(and(...conditions))
      .orderBy(asc(importMatchRules.priority), desc(importMatchRules.createdAt));
  }),

  byId: protectedProcedure.input(z.string().uuid()).query(async ({ ctx, input: id }) => {
    const [row] = await ctx.db.raw
      .select()
      .from(importMatchRules)
      .where(
        and(
          eq(importMatchRules.id, id),
          eq(importMatchRules.tenantId, ctx.tenantId),
          isNull(importMatchRules.deletedAt),
        ),
      )
      .limit(1);
    if (!row) throw new TRPCError({ code: "NOT_FOUND" });
    return row;
  }),

  create: protectedProcedure.input(CreateTenantRuleInput).mutation(async ({ ctx, input }) => {
    assertRegexCompiles(input.matchKind, input.pattern);
    await assertUnderTenantCap(ctx.tenantId);
    const target = await validateTenantRuleTarget({
      targetKind: input.targetKind,
      lovTargetId: input.lovTargetId,
      tvTargetId: input.tvTargetId,
      tenantId: ctx.tenantId,
    });

    const created = await ctx.db.raw.transaction(async (tx) => {
      const [row] = await tx
        .insert(importMatchRules)
        .values(
          withSystemFields(ctx, "create", {
            tenantId: ctx.tenantId,
            category: null,
            targetKind: input.targetKind,
            matchKind: input.matchKind,
            pattern: input.pattern,
            lovTargetId: target.lovTargetId,
            tvTargetId: target.tvTargetId,
            confidence: input.confidence ?? 85,
            priority: input.priority ?? 100,
            origin: "admin",
            description: input.description ?? null,
          }),
        )
        .returning();
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await writeAuditEntry({
        ctx,
        entityType: ENTITY_TYPE,
        entityId: row.id,
        action: "create",
        after: row,
        tx,
      });
      return row;
    });

    clearMatchRulesCache({ kind: "tenant", tenantId: ctx.tenantId });
    return created;
  }),

  update: protectedProcedure.input(UpdateTenantRuleInput).mutation(async ({ ctx, input }) => {
    if (input.matchKind !== undefined && input.pattern !== undefined) {
      assertRegexCompiles(input.matchKind, input.pattern);
    }

    const [before] = await ctx.db.raw
      .select()
      .from(importMatchRules)
      .where(and(eq(importMatchRules.id, input.id), eq(importMatchRules.tenantId, ctx.tenantId)))
      .limit(1);
    if (!before) throw new TRPCError({ code: "NOT_FOUND" });

    // If matchKind changes but pattern stays, re-validate against the new kind.
    if (input.matchKind === "regex" && input.pattern === undefined) {
      assertRegexCompiles("regex", before.pattern);
    }

    const patch: Record<string, unknown> = {};
    if (input.matchKind !== undefined) patch["matchKind"] = input.matchKind;
    if (input.pattern !== undefined) patch["pattern"] = input.pattern;
    if (input.confidence !== undefined) patch["confidence"] = input.confidence;
    if (input.priority !== undefined) patch["priority"] = input.priority;
    if (input.description !== undefined) patch["description"] = input.description;

    if (Object.keys(patch).length === 0) return before;

    const updated = await ctx.db.raw.transaction(async (tx) => {
      const [row] = await tx
        .update(importMatchRules)
        .set(withSystemFields(ctx, "update", patch))
        .where(eq(importMatchRules.id, input.id))
        .returning();
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await writeAuditEntry({
        ctx,
        entityType: ENTITY_TYPE,
        entityId: row.id,
        action: "update",
        before,
        after: row,
        tx,
      });
      return row;
    });

    clearMatchRulesCache({ kind: "tenant", tenantId: ctx.tenantId });
    return updated;
  }),

  deactivate: protectedProcedure.input(z.string().uuid()).mutation(async ({ ctx, input: id }) => {
    const [before] = await ctx.db.raw
      .select()
      .from(importMatchRules)
      .where(and(eq(importMatchRules.id, id), eq(importMatchRules.tenantId, ctx.tenantId)))
      .limit(1);
    if (!before) throw new TRPCError({ code: "NOT_FOUND" });
    if (before.deletedAt !== null) return before;

    const deactivated = await ctx.db.raw.transaction(async (tx) => {
      const [row] = await tx
        .update(importMatchRules)
        .set(withSystemFields(ctx, "delete", {}))
        .where(eq(importMatchRules.id, id))
        .returning();
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await writeAuditEntry({
        ctx,
        entityType: ENTITY_TYPE,
        entityId: row.id,
        action: "delete",
        before,
        tx,
      });
      return row;
    });

    clearMatchRulesCache({ kind: "tenant", tenantId: ctx.tenantId });
    return deactivated;
  }),

  restore: protectedProcedure.input(z.string().uuid()).mutation(async ({ ctx, input: id }) => {
    const [before] = await ctx.db.raw
      .select()
      .from(importMatchRules)
      .where(and(eq(importMatchRules.id, id), eq(importMatchRules.tenantId, ctx.tenantId)))
      .limit(1);
    if (!before) throw new TRPCError({ code: "NOT_FOUND" });
    if (before.deletedAt === null) return before;

    const restored = await ctx.db.raw.transaction(async (tx) => {
      const [row] = await tx
        .update(importMatchRules)
        .set(withSystemFields(ctx, "restore", {}))
        .where(eq(importMatchRules.id, id))
        .returning();
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await writeAuditEntry({
        ctx,
        entityType: ENTITY_TYPE,
        entityId: row.id,
        action: "restore",
        before,
        after: row,
        tx,
      });
      return row;
    });

    clearMatchRulesCache({ kind: "tenant", tenantId: ctx.tenantId });
    return restored;
  }),

  // ──────────────────── System CRUD (superadmin path) ────────────────────

  /** List system rules (tenant_id IS NULL). Audience filter via `category`. */
  listSystem: adminProcedure.input(ListSystemRulesInput).query(async ({ ctx, input }) => {
    const conditions = [isNull(importMatchRules.tenantId)];
    if (input.targetKind !== undefined) {
      conditions.push(eq(importMatchRules.targetKind, input.targetKind));
    }
    if (input.category === null) {
      conditions.push(isNull(importMatchRules.category));
    } else if (input.category !== undefined) {
      conditions.push(eq(importMatchRules.category, input.category));
    }
    if (input.status === "active") conditions.push(isNull(importMatchRules.deletedAt));
    if (input.status === "inactive") conditions.push(isNotNull(importMatchRules.deletedAt));

    return ctx.db.raw
      .select()
      .from(importMatchRules)
      .where(and(...conditions))
      .orderBy(asc(importMatchRules.priority), desc(importMatchRules.createdAt));
  }),

  createSystem: adminProcedure.input(CreateSystemRuleInput).mutation(async ({ ctx, input }) => {
    assertRegexCompiles(input.matchKind, input.pattern);
    if (!isLovTargetKind(input.targetKind)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "system rules can only target system LOV rows (CATEGORY / PAYMENT_METHOD)",
      });
    }
    await assertLovTargetExists({
      targetId: input.lovTargetId,
      type: lovTypeFor(input.targetKind),
      tenantId: null,
    });

    const created = await ctx.db.raw.transaction(async (tx) => {
      const [row] = await tx
        .insert(importMatchRules)
        .values(
          withSystemFields(ctx, "create", {
            tenantId: null,
            category: input.category ?? null,
            targetKind: input.targetKind,
            matchKind: input.matchKind,
            pattern: input.pattern,
            lovTargetId: input.lovTargetId,
            tvTargetId: null,
            confidence: input.confidence ?? 85,
            priority: input.priority ?? 100,
            origin: "system_seed",
            description: input.description ?? null,
          }),
        )
        .returning();
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      // Audit-log row tagged with the actor's tenant — there is no system
      // tenant. Future "true superadmin" tiering can split this off.
      await writeAuditEntry({
        ctx,
        entityType: ENTITY_TYPE,
        entityId: row.id,
        action: "create",
        after: row,
        tx,
      });
      return row;
    });

    clearMatchRulesCache({ kind: "system" });
    return created;
  }),

  updateSystem: adminProcedure.input(UpdateSystemRuleInput).mutation(async ({ ctx, input }) => {
    if (input.matchKind !== undefined && input.pattern !== undefined) {
      assertRegexCompiles(input.matchKind, input.pattern);
    }

    const [before] = await ctx.db.raw
      .select()
      .from(importMatchRules)
      .where(and(eq(importMatchRules.id, input.id), isNull(importMatchRules.tenantId)))
      .limit(1);
    if (!before) throw new TRPCError({ code: "NOT_FOUND" });

    if (input.matchKind === "regex" && input.pattern === undefined) {
      assertRegexCompiles("regex", before.pattern);
    }

    const patch: Record<string, unknown> = {};
    if (input.matchKind !== undefined) patch["matchKind"] = input.matchKind;
    if (input.pattern !== undefined) patch["pattern"] = input.pattern;
    if (input.confidence !== undefined) patch["confidence"] = input.confidence;
    if (input.priority !== undefined) patch["priority"] = input.priority;
    if (input.description !== undefined) patch["description"] = input.description;
    if (input.category !== undefined) patch["category"] = input.category;

    if (Object.keys(patch).length === 0) return before;

    const updated = await ctx.db.raw.transaction(async (tx) => {
      const [row] = await tx
        .update(importMatchRules)
        .set(withSystemFields(ctx, "update", patch))
        .where(eq(importMatchRules.id, input.id))
        .returning();
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await writeAuditEntry({
        ctx,
        entityType: ENTITY_TYPE,
        entityId: row.id,
        action: "update",
        before,
        after: row,
        tx,
      });
      return row;
    });

    clearMatchRulesCache({ kind: "system" });
    return updated;
  }),

  deactivateSystem: adminProcedure.input(z.string().uuid()).mutation(async ({ ctx, input: id }) => {
    const [before] = await ctx.db.raw
      .select()
      .from(importMatchRules)
      .where(and(eq(importMatchRules.id, id), isNull(importMatchRules.tenantId)))
      .limit(1);
    if (!before) throw new TRPCError({ code: "NOT_FOUND" });
    if (before.deletedAt !== null) return before;

    const deactivated = await ctx.db.raw.transaction(async (tx) => {
      const [row] = await tx
        .update(importMatchRules)
        .set(withSystemFields(ctx, "delete", {}))
        .where(eq(importMatchRules.id, id))
        .returning();
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await writeAuditEntry({
        ctx,
        entityType: ENTITY_TYPE,
        entityId: row.id,
        action: "delete",
        before,
        tx,
      });
      return row;
    });

    clearMatchRulesCache({ kind: "system" });
    return deactivated;
  }),

  restoreSystem: adminProcedure.input(z.string().uuid()).mutation(async ({ ctx, input: id }) => {
    const [before] = await ctx.db.raw
      .select()
      .from(importMatchRules)
      .where(and(eq(importMatchRules.id, id), isNull(importMatchRules.tenantId)))
      .limit(1);
    if (!before) throw new TRPCError({ code: "NOT_FOUND" });
    if (before.deletedAt === null) return before;

    const restored = await ctx.db.raw.transaction(async (tx) => {
      const [row] = await tx
        .update(importMatchRules)
        .set(withSystemFields(ctx, "restore", {}))
        .where(eq(importMatchRules.id, id))
        .returning();
      if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR" });
      await writeAuditEntry({
        ctx,
        entityType: ENTITY_TYPE,
        entityId: row.id,
        action: "restore",
        before,
        after: row,
        tx,
      });
      return row;
    });

    clearMatchRulesCache({ kind: "system" });
    return restored;
  }),
});
