// api/services/conciliation-match.ts
//
// G-02 matching on the acquirer's DECLARED settlement keys — no heuristics.
// Input: unmatched per-sale rows (with "Data prevista do pagamento") and
// unclaimed deposit rows from imported bank statements. Output: (sale ↔
// deposit) link pairs. Verified on real July data before implementation:
// pix 1:1 exact for 31/31 days; prevista batches equal the bank deposit for
// 30/31 (the 31st is a genuine acquirer shortfall and must NOT link).
//
//   pix_exact            1 sale ↔ 1 deposit. Sales the acquirer settles per
//                        sale (declared: expectedPaymentDate == saleDate)
//                        pair with self-referenced deposits tagged with the
//                        sale date, by exact value, each side consumed once.
//   prevista_batch       N sales ↔ 1 deposit. Remaining sales grouped by
//                        prevista ↔ the acquirer deposit whose memo S-tag
//                        equals the prevista AND whose amount equals the
//                        group sum. No sum → no links (shortfalls surface).
//   prevista_brand_batch N sales ↔ 1 deposit. Same, additionally split by
//                        brand family for per-brand payout lines.

export type SaleForMatch = {
  id: string;
  saleDate: string; // ISO
  method: string;
  brand: string | null;
  netAmount: bigint; // positive cents
  expectedPaymentDate: string; // ISO — the acquirer's declaration
};

export type DepositForMatch = {
  id: string;
  actualDate: string | null; // ISO (posted)
  description: string | null;
  actualAmount: bigint; // positive cents
};

export type MatchPair = {
  saleId: string;
  depositId: string;
  rule: "pix_exact" | "prevista_batch" | "prevista_brand_batch";
};

export type MatchOptions = {
  // Regex source recognizing the acquirer's deposits (LOV-driven).
  acquirerPattern: string;
  // Merchant identities (CPF/CNPJ) whose self-referenced deposits are
  // per-sale settlements.
  selfReferences: string[];
};

// Bandeira → token the bank prints on per-brand payout lines.
const BRAND_FAMILY: Record<string, string> = {
  Mastercard: "MAST",
  Visa: "VISA",
  Elo: "ELO",
};

type MatchState = {
  pairs: MatchPair[];
  usedDeposits: Set<string>;
  matchedSales: Set<string>;
};

const ddmm = (iso: string): string => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;

// A dd/mm tag has no year: only trust it when the posting date sits near the
// settlement date it names (postings slip by weekends, never by months).
const TAG_POSTING_WINDOW_DAYS = 7;

function postedNear(deposit: DepositForMatch, isoDate: string): boolean {
  if (deposit.actualDate === null) return false;
  const gap = Math.abs(Date.parse(deposit.actualDate) - Date.parse(isoDate)) / 86_400_000;
  return gap <= TAG_POSTING_WINDOW_DAYS;
}

// The dd/mm tag the bank memo embeds ("…CAMINHO03/08…", "…CIELO S04/08…");
// falls back to the posted date. Tags carry the acquirer's settlement day —
// postings can slip past midnight/weekends.
function depositDayTag(deposit: DepositForMatch): string | null {
  const tag = /(\d{2}\/\d{2})/.exec(deposit.description ?? "");
  if (tag !== null) return tag[1] ?? null;
  const date = deposit.actualDate;
  return date !== null ? ddmm(date) : null;
}

export function runMatchRules(
  sales: readonly SaleForMatch[],
  deposits: readonly DepositForMatch[],
  options: MatchOptions,
): MatchPair[] {
  const state: MatchState = { pairs: [], usedDeposits: new Set(), matchedSales: new Set() };
  const acquirerRe = new RegExp(options.acquirerPattern, "i");
  const acquirerDeposits = deposits.filter((d) => acquirerRe.test(d.description ?? ""));
  const selfDeposits = deposits.filter((d) =>
    options.selfReferences.some((ref) => (d.description ?? "").includes(ref)),
  );

  applyPixExact(sales, selfDeposits, state);
  applyPrevistaBatch(sales, acquirerDeposits, state);
  applyBrandBatch(sales, acquirerDeposits, state);
  return state.pairs;
}

// pix_exact — per-sale settlements (prevista == sale date) pair 1:1 with
// same-tag self deposits by exact value: both sides sorted, consumed once.
function applyPixExact(
  sales: readonly SaleForMatch[],
  selfDeposits: readonly DepositForMatch[],
  state: MatchState,
): void {
  const depositsByTag = new Map<string, DepositForMatch[]>();
  for (const d of selfDeposits) {
    const tag = depositDayTag(d);
    if (tag === null) continue;
    const list = depositsByTag.get(tag) ?? [];
    list.push(d);
    depositsByTag.set(tag, list);
  }

  const perSaleSales = sales.filter((s) => s.expectedPaymentDate === s.saleDate);
  const salesByTag = new Map<string, SaleForMatch[]>();
  for (const s of perSaleSales) {
    const tag = ddmm(s.saleDate);
    const list = salesByTag.get(tag) ?? [];
    list.push(s);
    salesByTag.set(tag, list);
  }

  for (const [tag, tagSales] of salesByTag) {
    const saleDay = tagSales[0]?.saleDate ?? "";
    const tagDeposits = (depositsByTag.get(tag) ?? []).filter((d) => postedNear(d, saleDay));
    const byValue = new Map<bigint, DepositForMatch[]>();
    for (const d of tagDeposits) {
      const list = byValue.get(d.actualAmount) ?? [];
      list.push(d);
      byValue.set(d.actualAmount, list);
    }
    for (const sale of tagSales) {
      const candidates = byValue.get(sale.netAmount);
      const deposit = candidates?.find((d) => !state.usedDeposits.has(d.id));
      if (deposit === undefined) continue;
      state.usedDeposits.add(deposit.id);
      state.matchedSales.add(sale.id);
      state.pairs.push({ saleId: sale.id, depositId: deposit.id, rule: "pix_exact" });
    }
  }
}

function groupRemainingByPrevista(
  sales: readonly SaleForMatch[],
  state: MatchState,
  subKey: (s: SaleForMatch) => string | null,
): Map<string, SaleForMatch[]> {
  const groups = new Map<string, SaleForMatch[]>();
  for (const s of sales) {
    if (state.matchedSales.has(s.id)) continue;
    const sub = subKey(s);
    if (sub === null) continue;
    const key = `${s.expectedPaymentDate}|${sub}`;
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }
  return groups;
}

function linkGroup(
  group: SaleForMatch[],
  deposit: DepositForMatch,
  rule: MatchPair["rule"],
  state: MatchState,
): void {
  state.usedDeposits.add(deposit.id);
  for (const sale of group) {
    state.matchedSales.add(sale.id);
    state.pairs.push({ saleId: sale.id, depositId: deposit.id, rule });
  }
}

// Word-boundary match: "ELO" must not fire inside "CIELO".
const BRAND_TOKEN_RES = Object.values(BRAND_FAMILY).map((t) => new RegExp(`\\b${t}\\b`));

function hasBrandToken(deposit: DepositForMatch): boolean {
  return BRAND_TOKEN_RES.some((re) => re.test(deposit.description ?? ""));
}

function hasFamilyToken(deposit: DepositForMatch, family: string): boolean {
  return new RegExp(`\\b${family}\\b`).test(deposit.description ?? "");
}

// prevista_batch — all remaining BATCH-settled sales of one prevista ↔ the
// S-tagged acquirer deposit of that prevista, only on an exact sum. Sales
// on the per-sale route (prevista == sale date) never join a batch: a pix
// missing its bank line must stay pending without breaking the card batch.
// Brand-labeled deposits belong to the brand rule and are refused here.
function applyPrevistaBatch(
  sales: readonly SaleForMatch[],
  acquirerDeposits: readonly DepositForMatch[],
  state: MatchState,
): void {
  const groups = groupRemainingByPrevista(sales, state, (s) =>
    s.expectedPaymentDate === s.saleDate ? null : "all",
  );
  for (const [key, group] of groups) {
    const prevista = key.split("|")[0] ?? "";
    const sum = group.reduce((acc, s) => acc + s.netAmount, 0n);
    const deposit = acquirerDeposits.find(
      (d) =>
        !state.usedDeposits.has(d.id) &&
        !hasBrandToken(d) &&
        depositDayTag(d) === ddmm(prevista) &&
        postedNear(d, prevista) &&
        d.actualAmount === sum,
    );
    if (deposit !== undefined) linkGroup(group, deposit, "prevista_batch", state);
  }
}

// Settlement class the payout memo declares as a DB/CD prefix on the
// merchant account ("RECEBIMENTO CIELO VISA CD2762811877"): débito-method
// sales pay out on DB lines, everything else on CD lines. A memo with
// neither prefix accepts any class (older single-line format).
function saleClass(sale: SaleForMatch): "DB" | "CD" {
  return /d[eé]bito/i.test(sale.method) ? "DB" : "CD";
}

// A class-prefixed payout only pays its declared class; the whole-family
// pass ("any") only takes unprefixed lines, so a mixed group can never
// swallow a débito-only or crédito-only payout.
function classAccepted(deposit: DepositForMatch, cls: string): boolean {
  const description = deposit.description ?? "";
  const prefixed = /\b(?:DB|CD)\d/.test(description);
  if (cls === "any") return !prefixed;
  return prefixed ? new RegExp(`\\b${cls}\\d`).test(description) : true;
}

// prevista_brand_batch — per-brand payout lines: remaining sales grouped by
// (prevista, brand family, settlement class) ↔ the family-labeled deposit
// posted on the prevista with the exact subgroup sum. Grouping tries the
// class-split grain first, then the whole family — payouts arrived as one
// line per family before Cielo split débito and crédito lines.
function applyBrandBatch(
  sales: readonly SaleForMatch[],
  acquirerDeposits: readonly DepositForMatch[],
  state: MatchState,
): void {
  brandBatchPass(
    sales,
    acquirerDeposits,
    state,
    (s) => `${BRAND_FAMILY[s.brand ?? ""] ?? ""}|${saleClass(s)}`,
  );
  brandBatchPass(sales, acquirerDeposits, state, (s) => `${BRAND_FAMILY[s.brand ?? ""] ?? ""}|any`);
}

function brandBatchPass(
  sales: readonly SaleForMatch[],
  acquirerDeposits: readonly DepositForMatch[],
  state: MatchState,
  makeSubKey: (s: SaleForMatch) => string,
): void {
  // Per-sale-route sales (prevista == sale date) never join a brand batch.
  const groups = groupRemainingByPrevista(sales, state, (s) => {
    if (s.expectedPaymentDate === s.saleDate || s.brand === null) return null;
    if (BRAND_FAMILY[s.brand] === undefined) return null;
    return makeSubKey(s);
  });
  for (const [key, group] of groups) {
    const [prevista, family, cls] = key.split("|");
    if (prevista === undefined || family === undefined || family === "") continue;
    const sum = group.reduce((acc, s) => acc + s.netAmount, 0n);
    const deposit = acquirerDeposits.find(
      (d) =>
        !state.usedDeposits.has(d.id) &&
        hasFamilyToken(d, family) &&
        classAccepted(d, cls ?? "any") &&
        (d.actualDate === prevista || depositDayTag(d) === ddmm(prevista)) &&
        postedNear(d, prevista) &&
        d.actualAmount === sum,
    );
    if (deposit !== undefined) linkGroup(group, deposit, "prevista_brand_batch", state);
  }
}
