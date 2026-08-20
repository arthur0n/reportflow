// TrigramFuzzyMatcher — wraps the existing pg_trgm similarity services.
//
// Filters out similarity=1.0 hits (exact-code overlap is owned by
// ExactCodeMatcher). Linear remap [0.4, 1.0] → [0.4, 0.7], capped at 0.7 so
// fuzzy alone never auto-applies.

import { db } from "../../../db/client";
import { findSimilarLovRows } from "../../../services/lov-similarity";
import { findSimilarTenantValues } from "../../../services/tenant-values-similarity";
import { normalizeForMatch } from "../normalize";
import type { Matcher, MatchCandidate, MatchInput } from "../types";

const SIM_FLOOR = 0.4;
const SIM_CEIL = 1.0;
const CONF_FLOOR = 0.4;
const CONF_CEIL = 0.7;

function similarityToConfidence(similarity: number): number {
  const remapped =
    CONF_FLOOR + (similarity - SIM_FLOOR) * ((CONF_CEIL - CONF_FLOOR) / (SIM_CEIL - SIM_FLOOR));
  if (remapped < CONF_FLOOR) return CONF_FLOOR;
  if (remapped > CONF_CEIL) return CONF_CEIL;
  return remapped;
}

export function createTrigramFuzzyMatcher(opts: { priority: number }): Matcher {
  return {
    id: "trigram",
    priority: opts.priority,
    async match(input: MatchInput): Promise<MatchCandidate[]> {
      const candidate = normalizeForMatch(input.candidate);
      if (candidate.length === 0) return [];

      const { target, ctx } = input;

      if (target.kind === "tenant-value") {
        const matches = await findSimilarTenantValues({
          db,
          tenantId: ctx.tenantId,
          kind: target.tvKind,
          candidateValue: candidate,
        });
        return matches
          .filter((m) => m.similarity < 1.0)
          .map((m) => ({
            targetId: m.id,
            targetCode: m.code,
            targetValue: m.value,
            confidence: similarityToConfidence(m.similarity),
            strategyId: "trigram",
            reason: `trigram: ${m.similarity.toFixed(2)}`,
          }));
      }

      const scope =
        ctx.tenantIndustry !== null && ctx.tenantIndustry.length > 0
          ? ({
              kind: "tenant",
              tenantId: ctx.tenantId,
              tenantIndustry: ctx.tenantIndustry,
            } as const)
          : ({ kind: "admin-all" } as const);

      const matches = await findSimilarLovRows({
        db,
        type: target.type,
        candidateValue: candidate,
        scope,
      });

      return matches
        .filter((m) => m.similarity < 1.0)
        .map((m) => ({
          targetId: m.id,
          targetCode: m.code,
          targetValue: m.value,
          confidence: similarityToConfidence(m.similarity),
          strategyId: "trigram",
          reason: `trigram: ${m.similarity.toFixed(2)}`,
        }));
    },
  };
}
