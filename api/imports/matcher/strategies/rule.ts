// RuleMatcher — runs system + tenant rules against the raw candidate string.
//
// Rules are user-authored and meant to match bank-statement-shaped text, so
// matching is on the raw input (NOT normalizeForMatch). Loads two pools and
// merges; tenant rules win ties on equal confidence (lower priority wins;
// pool tie-break prefers tenant). Emits one MatchCandidate per matched rule
// at confidence = rule.confidence / 100.
//
// Per-Lambda cache keyed separately for system (by industry) and tenant pools.

import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "../../../db/client";
import { importMatchRules, listOfValues, tenantValues } from "../../../../drizzle/schema";
import type { Matcher, MatchCandidate, MatchInput, MatchTarget } from "../types";

type TargetKind = "CATEGORY" | "PAYMENT_METHOD" | "SUPPLIER" | "CUSTOMER" | "SUBTYPE";

type LoadedRule = {
  id: string;
  targetKind: string;
  matchKind: string;
  pattern: string;
  lovTargetId: string | null;
  tvTargetId: string | null;
  confidence: number;
  priority: number;
  // Compiled regex when matchKind='regex'; null when compile failed; undefined for non-regex.
  regex: RegExp | null | undefined;
  pool: "system" | "tenant";
};

const REASON_PATTERN_MAX = 60;

const systemCache = new Map<string, LoadedRule[]>();
const tenantCache = new Map<string, LoadedRule[]>();

function systemKey(targetKind: TargetKind, tenantIndustry: string | null): string {
  return `${targetKind}|${tenantIndustry ?? "__none"}`;
}

function tenantKey(tenantId: string, targetKind: TargetKind): string {
  return `${tenantId}|${targetKind}`;
}

function compileRegex(rule: { id: string; matchKind: string; pattern: string }): RegExp | null {
  try {
    return new RegExp(rule.pattern, "i");
  } catch (err) {
    console.warn(
      `RuleMatcher: skipping rule ${rule.id} — pattern failed to compile: ${String(err)}`,
    );
    return null;
  }
}

function attachRegex(row: Omit<LoadedRule, "regex">): LoadedRule {
  if (row.matchKind === "regex") {
    return { ...row, regex: compileRegex(row) };
  }
  return { ...row, regex: undefined };
}

function mapTargetKind(target: MatchTarget): TargetKind | null {
  if (target.kind === "tenant-value") {
    if (target.tvKind === "SUPPLIER" || target.tvKind === "CUSTOMER") return target.tvKind;
    return null;
  }
  if (target.type === "CATEGORY") return "CATEGORY";
  if (target.type === "PAYMENT_METHOD") return "PAYMENT_METHOD";
  if (target.type === "TRANSACTION_SUBTYPE") return "SUBTYPE";
  return null;
}

async function loadSystemRules(
  targetKind: TargetKind,
  tenantIndustry: string | null,
): Promise<LoadedRule[]> {
  const key = systemKey(targetKind, tenantIndustry);
  const cached = systemCache.get(key);
  if (cached !== undefined) return cached;

  const audienceFilter =
    tenantIndustry === null
      ? isNull(importMatchRules.category)
      : or(isNull(importMatchRules.category), eq(importMatchRules.category, tenantIndustry));

  const rows = await db
    .select({
      id: importMatchRules.id,
      targetKind: importMatchRules.targetKind,
      matchKind: importMatchRules.matchKind,
      pattern: importMatchRules.pattern,
      lovTargetId: importMatchRules.lovTargetId,
      tvTargetId: importMatchRules.tvTargetId,
      confidence: importMatchRules.confidence,
      priority: importMatchRules.priority,
    })
    .from(importMatchRules)
    .where(
      and(
        isNull(importMatchRules.tenantId),
        isNull(importMatchRules.deletedAt),
        eq(importMatchRules.targetKind, targetKind),
        audienceFilter,
      ),
    )
    .orderBy(asc(importMatchRules.priority));

  const loaded = rows.map((r) =>
    attachRegex({
      id: r.id,
      targetKind: r.targetKind,
      matchKind: r.matchKind,
      pattern: r.pattern,
      lovTargetId: r.lovTargetId,
      tvTargetId: r.tvTargetId,
      confidence: Number(r.confidence),
      priority: Number(r.priority),
      pool: "system",
    }),
  );

  systemCache.set(key, loaded);
  return loaded;
}

async function loadTenantRules(tenantId: string, targetKind: TargetKind): Promise<LoadedRule[]> {
  const key = tenantKey(tenantId, targetKind);
  const cached = tenantCache.get(key);
  if (cached !== undefined) return cached;

  const rows = await db
    .select({
      id: importMatchRules.id,
      targetKind: importMatchRules.targetKind,
      matchKind: importMatchRules.matchKind,
      pattern: importMatchRules.pattern,
      lovTargetId: importMatchRules.lovTargetId,
      tvTargetId: importMatchRules.tvTargetId,
      confidence: importMatchRules.confidence,
      priority: importMatchRules.priority,
    })
    .from(importMatchRules)
    .where(
      and(
        eq(importMatchRules.tenantId, tenantId),
        isNull(importMatchRules.deletedAt),
        eq(importMatchRules.targetKind, targetKind),
      ),
    )
    .orderBy(asc(importMatchRules.priority));

  const loaded = rows.map((r) =>
    attachRegex({
      id: r.id,
      targetKind: r.targetKind,
      matchKind: r.matchKind,
      pattern: r.pattern,
      lovTargetId: r.lovTargetId,
      tvTargetId: r.tvTargetId,
      confidence: Number(r.confidence),
      priority: Number(r.priority),
      pool: "tenant",
    }),
  );

  tenantCache.set(key, loaded);
  return loaded;
}

/**
 * Bust the per-Lambda rule cache.
 * - { kind: 'all' }                          → drop everything.
 * - { kind: 'system' }                       → drop system pool only.
 * - { kind: 'tenant', tenantId }             → drop one tenant's entries.
 */
export function clearMatchRulesCache(
  scope: { kind: "all" } | { kind: "system" } | { kind: "tenant"; tenantId: string },
): void {
  if (scope.kind === "all") {
    systemCache.clear();
    tenantCache.clear();
    return;
  }
  if (scope.kind === "system") {
    systemCache.clear();
    return;
  }
  const prefix = `${scope.tenantId}|`;
  for (const k of [...tenantCache.keys()]) {
    if (k.startsWith(prefix)) tenantCache.delete(k);
  }
}

function evaluateRule(rule: LoadedRule, candidate: string): boolean {
  if (rule.matchKind === "regex") {
    if (rule.regex === null || rule.regex === undefined) return false;
    return rule.regex.test(candidate);
  }
  if (rule.matchKind === "contains") {
    return candidate.toLowerCase().includes(rule.pattern.toLowerCase());
  }
  if (rule.matchKind === "equals") {
    return candidate.trim().toLowerCase() === rule.pattern.trim().toLowerCase();
  }
  return false;
}

function truncatePattern(pattern: string): string {
  if (pattern.length <= REASON_PATTERN_MAX) return pattern;
  return `${pattern.slice(0, REASON_PATTERN_MAX)}…`;
}

async function loadTargetCatalog(
  refs: Array<{ kind: "lov" | "tv"; id: string }>,
): Promise<Map<string, { code: string; value: string }>> {
  const out = new Map<string, { code: string; value: string }>();
  const lovIds = refs.filter((r) => r.kind === "lov").map((r) => r.id);
  const tvIds = refs.filter((r) => r.kind === "tv").map((r) => r.id);

  if (lovIds.length > 0) {
    const rows = await db
      .select({ id: listOfValues.id, code: listOfValues.code, value: listOfValues.value })
      .from(listOfValues)
      .where(and(inArray(listOfValues.id, lovIds), isNull(listOfValues.deletedAt)));
    for (const r of rows) out.set(r.id, { code: r.code, value: r.value });
  }

  if (tvIds.length > 0) {
    const rows = await db
      .select({ id: tenantValues.id, code: tenantValues.code, value: tenantValues.value })
      .from(tenantValues)
      .where(and(inArray(tenantValues.id, tvIds), isNull(tenantValues.deletedAt)));
    for (const r of rows) out.set(r.id, { code: r.code, value: r.value });
  }

  return out;
}

type Hit = { rule: LoadedRule; targetRef: { kind: "lov" | "tv"; id: string } };

function ruleTargetRef(rule: LoadedRule): { kind: "lov" | "tv"; id: string } | null {
  if (rule.lovTargetId !== null) return { kind: "lov", id: rule.lovTargetId };
  if (rule.tvTargetId !== null) return { kind: "tv", id: rule.tvTargetId };
  return null;
}

function collectHits(rules: LoadedRule[], candidate: string): Hit[] {
  const hits: Hit[] = [];
  for (const rule of rules) {
    if (!evaluateRule(rule, candidate)) continue;
    const targetRef = ruleTargetRef(rule);
    if (targetRef === null) continue; // schema check enforces XOR; defensive
    hits.push({ rule, targetRef });
  }
  return hits;
}

// Tenant pool wins ties on equal confidence (pool order is set by the caller).
function dedupHits(hits: Hit[]): Hit[] {
  const byTarget = new Map<string, Hit>();
  for (const h of hits) {
    const existing = byTarget.get(h.targetRef.id);
    if (existing === undefined || h.rule.confidence > existing.rule.confidence) {
      byTarget.set(h.targetRef.id, h);
      continue;
    }
    const tied = h.rule.confidence === existing.rule.confidence;
    if (tied && h.rule.pool === "tenant" && existing.rule.pool === "system") {
      byTarget.set(h.targetRef.id, h);
    }
  }
  return [...byTarget.values()];
}

export function createRuleMatcher(opts: { priority: number }): Matcher {
  return {
    id: "rule",
    priority: opts.priority,
    async match(input: MatchInput): Promise<MatchCandidate[]> {
      const targetKind = mapTargetKind(input.target);
      if (targetKind === null) return [];

      const candidate = input.candidate;
      if (candidate.trim().length === 0) return [];

      const [systemPool, tenantPool] = await Promise.all([
        loadSystemRules(targetKind, input.ctx.tenantIndustry),
        loadTenantRules(input.ctx.tenantId, targetKind),
      ]);

      // Tenant pool first so dedup prefers it on confidence ties.
      const winners = dedupHits(collectHits([...tenantPool, ...systemPool], candidate));
      if (winners.length === 0) return [];

      const catalog = await loadTargetCatalog(winners.map((w) => w.targetRef));

      const out: MatchCandidate[] = [];
      for (const w of winners) {
        const meta = catalog.get(w.targetRef.id);
        if (meta === undefined) continue; // target soft-deleted since rule was authored
        out.push({
          targetId: w.targetRef.id,
          targetCode: meta.code,
          targetValue: meta.value,
          confidence: w.rule.confidence / 100,
          strategyId: `rule:${w.rule.id}`,
          reason: `${w.rule.matchKind}: ${truncatePattern(w.rule.pattern)}`,
        });
      }

      return out;
    },
  };
}
