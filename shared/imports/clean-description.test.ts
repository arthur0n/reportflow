import { describe, it, expect } from "vitest";
import { cleanDescriptionForCreate } from "./clean-description";

const NOISE = [
  "PIX ENVIADO",
  "PIX RECEBIDO",
  "PAGAMENTO DE BOLETO OUTROS BANCOS",
  "PAGAMENTO DE BOLETO",
  "TED ENVIADA",
  "TRANSFERÊNCIA ENVIADA",
  "TARIFA",
];

describe("cleanDescriptionForCreate", () => {
  it("strips a prefix and collapses whitespace", () => {
    expect(
      cleanDescriptionForCreate(
        "PIX ENVIADO                        Arthur Cavalcanti Nunes d",
        NOISE,
      ),
    ).toBe("Arthur Cavalcanti Nunes d");
  });

  it("prefers the longest matching phrase", () => {
    expect(
      cleanDescriptionForCreate(
        "PAGAMENTO DE BOLETO OUTROS BANCOS PORTO SEGURO ADMINISTRADO",
        NOISE,
      ),
    ).toBe("PORTO SEGURO ADMINISTRADO");
  });

  it("matches accent-insensitively but preserves the tail's casing and accents", () => {
    expect(cleanDescriptionForCreate("PIX RECEBIDO João da Silva", NOISE)).toBe("João da Silva");
    expect(cleanDescriptionForCreate("TRANSFERENCIA ENVIADA Padaria Pão", NOISE)).toBe(
      "Padaria Pão",
    );
  });

  it("does not strip a phrase that occurs mid-string", () => {
    expect(cleanDescriptionForCreate("Empresa X PIX ENVIADO", NOISE)).toBe("Empresa X PIX ENVIADO");
  });

  it("requires a word boundary after the phrase", () => {
    expect(cleanDescriptionForCreate("TARIFAÇÃO mensal", NOISE)).toBe("TARIFAÇÃO mensal");
  });

  it("returns the trimmed original when nothing matches", () => {
    expect(cleanDescriptionForCreate("  Cliente Avulso  ", NOISE)).toBe("Cliente Avulso");
  });

  it("returns the trimmed original when noise list is empty", () => {
    expect(cleanDescriptionForCreate("PIX ENVIADO Foo", [])).toBe("PIX ENVIADO Foo");
  });

  it("returns empty string when input is empty or all noise", () => {
    expect(cleanDescriptionForCreate("", NOISE)).toBe("");
    expect(cleanDescriptionForCreate("   PIX ENVIADO   ", NOISE)).toBe("");
  });
});
