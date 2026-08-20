import { describe, it, expect } from "vitest";
import { runMatchRules, type SaleForMatch, type DepositForMatch } from "./conciliation-match";

const OPTS = { acquirerPattern: "CIELO", selfReferences: ["63.735.376/0001-64"] };

const sale = (id: string, netAmount: bigint, over: Partial<SaleForMatch> = {}): SaleForMatch => ({
  id,
  saleDate: "2026-07-01",
  method: "Crédito à vista",
  brand: "Visa",
  netAmount,
  expectedPaymentDate: "2026-07-02",
  ...over,
});

const pixSale = (id: string, netAmount: bigint, day = "2026-07-01"): SaleForMatch =>
  sale(id, netAmount, { method: "Pix", brand: "Pix", saleDate: day, expectedPaymentDate: day });

const deposit = (
  id: string,
  actualAmount: bigint,
  description: string,
  actualDate = "2026-07-02",
): DepositForMatch => ({ id, actualAmount, description, actualDate });

const selfPix = (id: string, amount: bigint, tag: string): DepositForMatch =>
  deposit(id, amount, `PIX RECEBIDO CAMINHO${tag} CAMINHO LTDA 63.735.376/0001-64`, "2026-07-01");

describe("pix_exact", () => {
  it("pairs per-sale settlements 1:1 by day tag and exact value", () => {
    const pairs = runMatchRules(
      [pixSale("s1", 2743n), pixSale("s2", 4410n)],
      [selfPix("d1", 2743n, "01/07"), selfPix("d2", 4410n, "01/07")],
      OPTS,
    );
    expect(pairs).toHaveLength(2);
    expect(pairs.every((p) => p.rule === "pix_exact")).toBe(true);
  });

  it("consumes each deposit once even with duplicate values", () => {
    const pairs = runMatchRules(
      [pixSale("s1", 1097n), pixSale("s2", 1097n)],
      [selfPix("d1", 1097n, "01/07")],
      OPTS,
    );
    expect(pairs).toHaveLength(1);
  });

  it("does not pair across different day tags", () => {
    const pairs = runMatchRules([pixSale("s1", 2743n)], [selfPix("d1", 2743n, "02/07")], OPTS);
    expect(pairs).toEqual([]);
  });
});

describe("prevista_batch", () => {
  it("links a prevista group to the S-tagged deposit with the exact sum", () => {
    const pairs = runMatchRules(
      [sale("cred", 239693n), sale("deb", 74822n, { method: "Débito à vista" })],
      [deposit("d1", 314515n, "PIX RECEBIDO CIELO S02/07 CIELO S.A")],
      OPTS,
    );
    expect(pairs).toHaveLength(2);
    expect(pairs.every((p) => p.rule === "prevista_batch" && p.depositId === "d1")).toBe(true);
  });

  it("links NOTHING when the deposit is short (acquirer shortfall)", () => {
    const pairs = runMatchRules(
      [sale("cred", 239693n), sale("deb", 74822n)],
      [deposit("d1", 300000n, "PIX RECEBIDO CIELO S02/07 CIELO S.A")],
      OPTS,
    );
    expect(pairs).toEqual([]);
  });

  it("a pix sale missing its bank line does not break the card batch", () => {
    const pairs = runMatchRules(
      [pixSale("pix-lost", 5000n), sale("cred", 239693n), sale("deb", 74822n)],
      [deposit("d1", 314515n, "PIX RECEBIDO CIELO S02/07 CIELO S.A")],
      OPTS,
    );
    expect(pairs.map((p) => p.saleId).sort()).toEqual(["cred", "deb"]);
  });

  it("does not link a deposit whose tag is another prevista", () => {
    const pairs = runMatchRules(
      [sale("cred", 239693n), sale("deb", 74822n)],
      [deposit("d1", 314515n, "PIX RECEBIDO CIELO S03/07 CIELO S.A")],
      OPTS,
    );
    expect(pairs).toEqual([]);
  });
});

describe("prevista_brand_batch", () => {
  it("links (prevista, brand family) groups to the per-brand payout lines", () => {
    const pairs = runMatchRules(
      [
        sale("m1", 90889n, { brand: "Mastercard", method: "Débito à vista" }),
        sale("v1", 11512n, { brand: "Visa", method: "Débito à vista" }),
        sale("e1", 4483n, { brand: "Elo", method: "Débito à vista" }),
      ],
      [
        deposit("mast", 90889n, "RECEBIMENTO CIELO MAST DB276"),
        deposit("visa", 11512n, "RECEBIMENTO CIELO VISA DB276"),
        deposit("elo", 4483n, "RECEBIMENTO CIELO ELO DB276"),
      ],
      OPTS,
    );
    expect(pairs).toHaveLength(3);
    expect(pairs.every((p) => p.rule === "prevista_brand_batch")).toBe(true);
    expect(new Map(pairs.map((p) => [p.saleId, p.depositId])).get("m1")).toBe("mast");
  });

  it("brand batch requires the deposit on the prevista date", () => {
    const pairs = runMatchRules(
      [sale("m1", 90889n, { brand: "Mastercard" })],
      [deposit("mast", 90889n, "RECEBIMENTO CIELO MAST DB276", "2026-07-05")],
      OPTS,
    );
    expect(pairs).toEqual([]);
  });

  it("splits one brand family across DB (débito) and CD (crédito) payout lines", () => {
    const pairs = runMatchRules(
      [
        sale("deb1", 100000n, { brand: "Visa", method: "Débito à vista" }),
        sale("deb2", 83657n, { brand: "Visa", method: "Débito pré-pago" }),
        sale("cred1", 197385n, { brand: "Visa", method: "Crédito à vista" }),
      ],
      [
        deposit("visa-db", 183657n, "RECEBIMENTO CIELO CIELO VISA DB2762811877"),
        deposit("visa-cd", 197385n, "RECEBIMENTO CIELO CIELO VISA CD2762811877"),
      ],
      OPTS,
    );
    const byId = new Map(pairs.map((p) => [p.saleId, p.depositId]));
    expect(byId.get("deb1")).toBe("visa-db");
    expect(byId.get("deb2")).toBe("visa-db");
    expect(byId.get("cred1")).toBe("visa-cd");
  });

  it("a débito-class group never takes a CD-labeled deposit even on equal sum", () => {
    const pairs = runMatchRules(
      [sale("deb1", 197385n, { brand: "Visa", method: "Débito à vista" })],
      [deposit("visa-cd", 197385n, "RECEBIMENTO CIELO CIELO VISA CD2762811877")],
      OPTS,
    );
    expect(pairs).toEqual([]);
  });

  it("a whole-family group still matches the single unprefixed payout line", () => {
    const pairs = runMatchRules(
      [
        sale("deb1", 100000n, { brand: "Visa", method: "Débito à vista" }),
        sale("cred1", 97385n, { brand: "Visa", method: "Crédito à vista" }),
      ],
      [deposit("visa", 197385n, "RECEBIMENTO CIELO VISA")],
      OPTS,
    );
    expect(pairs).toHaveLength(2);
    expect(pairs.every((p) => p.depositId === "visa")).toBe(true);
  });
});
