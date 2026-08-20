// LearnedDecisionMatcher — windowed aggregate over import_match_decisions.
//
// Confidence per target = min(0.98, 0.5 + 0.5 * tanh(score / 3)) where
// score = Σ weight(decisionKind) * exp(-ageDays / 60) over the last 180 days,
// weights: accepted=1.0, manual=1.0, overridden=0.0. Half-life ~42d, cap at
// 0.98 so ExactCode wins ties on saturated targets.
//
// Clock injected via factory for deterministic tests.

import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../../db/client";
import { importMatchDecisions, listOfValues, tenantValues } from "../../../../drizzle/schema";
import { normalizeForMatch } from "../normalize";
import type { Matcher, MatchCandidate, MatchInput, MatchTarget } from "../types";

const WINDOW_DAYS = 180;
const HALF_LIFE_SCALE_DAYS = 60;
const SCORE_NORMALIZER = 3;
const CONFIDENCE_CAP = 0.98;
const MIN_EMIT_CONFIDENCE = 0.4;
const RECENT_LIMIT = 50;

type TargetKind = "CATEGORY" | "PAYMENT_METHOD" | "SUPPLIER" | "CUSTOMER" | "SUBTYPE";

type DecisionRow = {
  lovTargetId: string | null;
  tvTargetId: string | null;
  decisionKind: string;
  createdAt: string;
};

type TargetRef = { kind: "lov" | "tv"; id: string };

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

function decisionWeight(kind: string): number {
  if (kind === "accepted" || kind === "manual") return 1.0;
  return 0;
}

function computeConfidence(score: number): number {
  return Math.min(CONFIDENCE_CAP, 0.5 + 0.5 * Math.tanh(score / SCORE_NORMALIZER));
}

async function loadTargetCatalog(
  refs: TargetRef[],
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

export function createLearnedDecisionMatcher(opts: {
  priority: number;
  now?: () => Date;
}): Matcher {
  const now = opts.now ?? ((): Date => new Date());

  return {
    id: "learned",
    priority: opts.priority,
    async match(input: MatchInput): Promise<MatchCandidate[]> {
      const targetKind = mapTargetKind(input.target);
      if (targetKind === null) return [];

      const normalized = normalizeForMatch(input.candidate);
      if (normalized.length === 0) return [];

      const nowDate = now();
      const cutoff = new Date(nowDate.getTime() - WINDOW_DAYS * 86_400_000);

      const decisions = (await db
        .select({
          lovTargetId: importMatchDecisions.lovTargetId,
          tvTargetId: importMatchDecisions.tvTargetId,
          decisionKind: importMatchDecisions.decisionKind,
          createdAt: importMatchDecisions.createdAt,
        })
        .from(importMatchDecisions)
        .where(
          and(
            eq(importMatchDecisions.tenantId, input.ctx.tenantId),
            eq(importMatchDecisions.targetKind, targetKind),
            eq(importMatchDecisions.inputNormalized, normalized),
            gt(importMatchDecisions.createdAt, sql`${cutoff.toISOString()}`),
          ),
        )
        .orderBy(desc(importMatchDecisions.createdAt))
        .limit(RECENT_LIMIT)) satisfies DecisionRow[];

      // Aggregate by target id; remember whether the id is LOV-side or TV-side.
      const aggregates = new Map<string, { kind: "lov" | "tv"; score: number; count: number }>();
      for (const d of decisions) {
        const id = d.lovTargetId ?? d.tvTargetId;
        if (id === null) continue;
        const w = decisionWeight(d.decisionKind);
        if (w === 0) continue;
        const ageDays = (nowDate.getTime() - new Date(d.createdAt).getTime()) / 86_400_000;
        const contribution = w * Math.exp(-ageDays / HALF_LIFE_SCALE_DAYS);
        const existing = aggregates.get(id);
        if (existing === undefined) {
          aggregates.set(id, {
            kind: d.lovTargetId !== null ? "lov" : "tv",
            score: contribution,
            count: 1,
          });
        } else {
          existing.score += contribution;
          existing.count += 1;
        }
      }

      if (aggregates.size === 0) return [];

      // Drop targets whose confidence wouldn't pass the suggest threshold anyway.
      const surviving: Array<{
        id: string;
        kind: "lov" | "tv";
        confidence: number;
        count: number;
      }> = [];
      for (const [id, agg] of aggregates) {
        const confidence = computeConfidence(agg.score);
        if (confidence < MIN_EMIT_CONFIDENCE) continue;
        surviving.push({ id, kind: agg.kind, confidence, count: agg.count });
      }

      if (surviving.length === 0) return [];

      const catalog = await loadTargetCatalog(surviving.map((s) => ({ kind: s.kind, id: s.id })));

      const out: MatchCandidate[] = [];
      for (const s of surviving) {
        const meta = catalog.get(s.id);
        if (meta === undefined) continue; // target was deleted since the decision
        out.push({
          targetId: s.id,
          targetCode: meta.code,
          targetValue: meta.value,
          confidence: s.confidence,
          strategyId: "learned",
          reason: `learned: ${s.count} confirmation(s)`,
        });
      }

      return out;
    },
  };
}
