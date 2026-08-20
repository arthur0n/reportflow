// api/services/bank-routing.ts
//
// OFX BANKID → bank slug lookup. BANK_ROUTING rows in list_of_values carry
// the routing code (e.g. "341"); their parent_lov FK points to the canonical
// BANK_SLUG row. Routing recognition is therefore seed-driven, not code-driven.
//
// Cache: per-Lambda Map of routing code → {slug, value}. Bust via
// clearBankRoutingCache from any procedure that mutates BANK_ROUTING or
// BANK_SLUG system rows.

import { and, eq, isNull } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../db/client";
import { listOfValues } from "../../drizzle/schema";

/**
 * Canonicalize a raw OFX BANKID to the 3-digit zero-padded COMPE form.
 * "0033" → "033", "33" → "033", "341" → "341", "1" → "001". Returns "" for
 * empty/whitespace input.
 */
export function normalizeBankId(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  const stripped = trimmed.replace(/^0+/, "");
  if (stripped.length === 0) return "000";
  return stripped.padStart(3, "0");
}

type RoutingHit = { slug: string; value: string };

let cache: Map<string, RoutingHit> | null = null;

async function loadRouting(): Promise<Map<string, RoutingHit>> {
  if (cache !== null) return cache;
  const parent = alias(listOfValues, "bank_slug_parent");
  const rows = await db
    .select({
      code: listOfValues.code,
      slug: parent.code,
      value: parent.value,
    })
    .from(listOfValues)
    .innerJoin(parent, eq(parent.id, listOfValues.parentLov))
    .where(
      and(
        eq(listOfValues.type, "BANK_ROUTING"),
        isNull(listOfValues.tenantId),
        isNull(listOfValues.deletedAt),
        eq(parent.type, "BANK_SLUG"),
        isNull(parent.tenantId),
        isNull(parent.deletedAt),
      ),
    );
  cache = new Map(rows.map((r) => [r.code, { slug: r.slug, value: r.value }]));
  return cache;
}

export function clearBankRoutingCache(): void {
  cache = null;
}

export async function resolveBankSlug(
  bankRoutingCode: string | null | undefined,
): Promise<RoutingHit | null> {
  if (bankRoutingCode === null || bankRoutingCode === undefined) return null;
  const key = normalizeBankId(bankRoutingCode);
  if (key.length === 0) return null;
  const map = await loadRouting();
  return map.get(key) ?? null;
}
