// api/billing/money.ts
//
// PORTED VERBATIM from smartstocke/api/billing/money.ts, which was itself
// ported verbatim from lexflow's `shared/domain/credit-money.ts`. Only this
// header is new.
//
// The logic is deliberately untouched: it is the checksum arithmetic the live
// system already bills on, and rewriting it during a port would put a
// behaviour change inside a copy. The original's tests came across with it and
// pass unmodified (api/billing/money.test.ts).
//
// Núcleo de dinheiro do billing de IA — funções puras, sem I/O.
// Multiplicador em ponto-fixo ×100 (100 = 1×, 200 = 2×), valores em centavos
// de USD. Regra do projeto (decisions §7): raw_usd_cents = custo real do
// provedor; owed_usd_cents = raw × multiplicador, congelado na gravação —
// nunca recalcular histórico.

export const MULT_MIN_X100 = 0;
export const MULT_MAX_X100 = 10000;
// 1× identidade — usado quando não há linha mult.<source> em credit_config.
export const MULT_DEFAULT_X100 = 100;
// Trava de sanidade: nenhuma chamada única pode custar mais que US$ 100.000.
export const RAW_CENTS_CAP = 100_000_00;

export function clampMultiplierX100(multX100: number): number {
  if (!Number.isFinite(multX100)) return MULT_MIN_X100;
  if (multX100 < MULT_MIN_X100) return MULT_MIN_X100;
  if (multX100 > MULT_MAX_X100) return MULT_MAX_X100;
  return Math.trunc(multX100);
}

export function capRawCents(rawCents: number): number {
  if (!Number.isFinite(rawCents)) return 0;
  if (rawCents < 0) return 0;
  if (rawCents > RAW_CENTS_CAP) return RAW_CENTS_CAP;
  return rawCents;
}

// owedCents = raw limitado × multiplicador limitado / 100.
// Resultado fica FRACIONÁRIO (numeric(12,4) no banco) — nunca arredondar aqui.
export function applyMultiplier(rawCents: number, multX100: number): number {
  const raw = capRawCents(rawCents);
  const mult = clampMultiplierX100(multX100);
  return (raw * mult) / 100;
}
