// Auto-match engine — public types.
//
// The chain runs at parse time (orchestrator pre-fills classifier FKs) and at
// review time (resolve.ts → tRPC pickers). One target shape, one match shape,
// one outcome discriminator — strategies are interchangeable behind it.

export type MatchTarget =
  | { kind: "lov-system"; type: string }
  | { kind: "lov-tenant"; type: string }
  | { kind: "tenant-value"; tvKind: string };

export type MatchTargetKey = `lov:${string}` | `tv:${string}`;

export function targetKey(target: MatchTarget): MatchTargetKey {
  if (target.kind === "tenant-value") return `tv:${target.tvKind}`;
  return `lov:${target.type}`;
}

export type MatchInputRow = {
  id: string | null;
  description: string | null;
  actualAmount: bigint | null;
  subtypeId: string | null;
  rawPayload: Record<string, unknown> | null;
};

export type MatchInputCtx = {
  tenantId: string;
  tenantIndustry: string | null;
  userId: string | null;
  bankSlug: string | null;
};

export type MatchInput = {
  candidate: string;
  row: MatchInputRow;
  target: MatchTarget;
  ctx: MatchInputCtx;
};

// One vote from one strategy for one target row.
export type MatchCandidate = {
  // FK into list_of_values OR tenant_values (depending on target.kind).
  targetId: string;
  targetCode: string;
  targetValue: string;
  // [0,1]. Each strategy documents its own mapping.
  confidence: number;
  // 'exact-code' | 'rule:<id>' | 'learned' | 'trigram' | 'ai'.
  strategyId: string;
  reason: string;
  meta?: Record<string, unknown>;
};

export type MatchOutcome =
  | { status: "matched"; best: MatchCandidate; alternatives: MatchCandidate[] }
  | { status: "suggested"; candidates: MatchCandidate[] }
  | { status: "none" };

export interface Matcher {
  readonly id: string;
  readonly priority: number;
  match(input: MatchInput): Promise<MatchCandidate[]>;
}
