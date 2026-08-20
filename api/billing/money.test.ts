// api/billing/money.test.ts
//
// PORTED VERBATIM from smartstocke/api/billing/money.test.ts, which came
// across unchanged from lexflow. Only this header is new — the point of a
// verbatim port is that its own tests come with it and pass unmodified.

import { describe, expect, it } from "vitest";
import {
  MULT_DEFAULT_X100,
  MULT_MAX_X100,
  MULT_MIN_X100,
  RAW_CENTS_CAP,
  applyMultiplier,
  capRawCents,
  clampMultiplierX100,
} from "./money";

describe("clampMultiplierX100", () => {
  it("mantém valores dentro da faixa e trunca frações", () => {
    expect(clampMultiplierX100(100)).toBe(100);
    expect(clampMultiplierX100(200)).toBe(200);
    expect(clampMultiplierX100(150.9)).toBe(150);
  });

  it("limita abaixo do mínimo e acima do máximo", () => {
    expect(clampMultiplierX100(-5)).toBe(MULT_MIN_X100);
    expect(clampMultiplierX100(99999)).toBe(MULT_MAX_X100);
  });

  it("não-finito (NaN, ±Infinity) cai no mínimo (0×, nunca cobra)", () => {
    expect(clampMultiplierX100(Number.NaN)).toBe(MULT_MIN_X100);
    expect(clampMultiplierX100(Number.POSITIVE_INFINITY)).toBe(MULT_MIN_X100);
    expect(clampMultiplierX100(Number.NEGATIVE_INFINITY)).toBe(MULT_MIN_X100);
  });

  it("padrão é 1× (100)", () => {
    expect(MULT_DEFAULT_X100).toBe(100);
  });
});

describe("capRawCents", () => {
  it("negativo e não-finito viram 0", () => {
    expect(capRawCents(-1)).toBe(0);
    expect(capRawCents(Number.NaN)).toBe(0);
    expect(capRawCents(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("valores normais passam intactos, inclusive fracionários", () => {
    expect(capRawCents(0.0123)).toBe(0.0123);
    expect(capRawCents(42)).toBe(42);
  });

  it("trava no teto de sanidade", () => {
    expect(capRawCents(RAW_CENTS_CAP + 1)).toBe(RAW_CENTS_CAP);
  });
});

describe("applyMultiplier", () => {
  it("2× dobra o custo bruto", () => {
    expect(applyMultiplier(10, 200)).toBe(20);
    expect(applyMultiplier(0.5, 200)).toBe(1);
  });

  it("1× é identidade e 0× zera", () => {
    expect(applyMultiplier(37.5, 100)).toBe(37.5);
    expect(applyMultiplier(37.5, 0)).toBe(0);
  });

  it("resultado permanece fracionário — sem arredondamento", () => {
    expect(applyMultiplier(0.0123, 200)).toBeCloseTo(0.0246, 10);
    expect(applyMultiplier(1, 150)).toBe(1.5);
  });

  it("entradas inválidas não geram cobrança espúria", () => {
    expect(applyMultiplier(Number.NaN, 200)).toBe(0);
    expect(applyMultiplier(-10, 200)).toBe(0);
    expect(applyMultiplier(10, Number.NaN)).toBe(0);
  });
});
