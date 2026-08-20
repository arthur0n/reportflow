// api/render/report-context.test.ts
//
// The deterministic half (§12.12b). Two properties carry the file:
//
//   * every DECLARED role is a key in the context, filled or not — otherwise
//     Handlebars strict mode turns `{{#if contrato}}` into a crash instead of
//     the empty branch, and "aguardando: contrato" stops being showable.
//   * aggregates are ALL-OR-NOTHING per role. A partial sum looks exactly like
//     a correct total and is the worst wrong number in the system.

import { describe, it, expect } from "vitest";
import { buildReportContext, todayInSaoPaulo } from "./report-context";
import type { RoleDeclarationT } from "../../shared/validation/outbound-schemas";

const FATURAS: RoleDeclarationT = {
  key: "faturas",
  documentTypeId: "11111111-1111-4111-8111-111111111111",
  provider: "House Living",
  documentType: "Fatura",
  cardinality: "many",
  required: true,
};

const CONTRATO: RoleDeclarationT = {
  key: "contrato",
  documentTypeId: "22222222-2222-4222-8222-222222222222",
  provider: "House Living",
  documentType: "Contrato",
  cardinality: "one",
  required: false,
};

const META = {
  titulo: "Relatório",
  cliente: "Cliente",
  emissao: "20/08/2026",
  n_documentos: 2,
};

function fatura(iliquido: string, iva: string, documento: string): { id: string; data: unknown } {
  return { id: `e-${iliquido}`, data: { totais: { iliquido, iva, documento } } };
}

describe("buildReportContext — roles", () => {
  it("puts every declared role in the context, even unfilled ones", () => {
    const built = buildReportContext({
      roles: [FATURAS, CONTRATO],
      bindings: [],
      meta: META,
    });
    expect(built.context).toHaveProperty("faturas", []);
    expect(built.context).toHaveProperty("contrato", null);
  });

  it("reports unfilled REQUIRED roles — §3.2's showable waiting state", () => {
    const built = buildReportContext({ roles: [FATURAS, CONTRATO], bindings: [], meta: META });
    expect(built.missingRequiredRoles).toEqual(["faturas"]);
  });

  it("addresses documents by role, never by index", () => {
    const built = buildReportContext({
      roles: [FATURAS, CONTRATO],
      bindings: [
        { roleKey: "faturas", extractions: [fatura("100,00 €", "23,00 €", "123,00 €")] },
        { roleKey: "contrato", extractions: [{ id: "c1", data: { titulo: "Contrato" } }] },
      ],
      meta: META,
    });
    expect(built.context["contrato"]).toEqual({ titulo: "Contrato" });
    expect(built.context["faturas"]).toHaveLength(1);
  });
});

describe("buildReportContext — aggregates", () => {
  it("sums the conventional money totals in integer cents", () => {
    const built = buildReportContext({
      roles: [FATURAS],
      bindings: [
        {
          roleKey: "faturas",
          extractions: [
            fatura("100,00 €", "23,00 €", "123,00 €"),
            fatura("1.000,00 €", "230,00 €", "1.230,00 €"),
          ],
        },
      ],
      meta: META,
    });
    expect(built.context["totais"]).toEqual({
      faturas: {
        n: 2,
        base_cents: 110000,
        iva_cents: 25300,
        documento_cents: 135300,
        confere: true,
      },
    });
    expect(built.aggregatedRoles).toEqual(["faturas"]);
  });

  it("reports a reconciliation failure instead of hiding or throwing on it", () => {
    const built = buildReportContext({
      roles: [FATURAS],
      bindings: [{ roleKey: "faturas", extractions: [fatura("100,00 €", "23,00 €", "999,00 €")] }],
      meta: META,
    });
    expect((built.context["totais"] as Record<string, { confere: boolean }>)["faturas"]).toEqual(
      expect.objectContaining({ confere: false }),
    );
  });

  it("produces NO aggregate for a role whose documents do not all carry totals", () => {
    const built = buildReportContext({
      roles: [FATURAS],
      bindings: [
        {
          roleKey: "faturas",
          extractions: [fatura("100,00 €", "23,00 €", "123,00 €"), { id: "x", data: { a: 1 } }],
        },
      ],
      meta: META,
    });
    expect(built.context["totais"]).toEqual({});
    expect(built.aggregatedRoles).toEqual([]);
  });

  it("produces no aggregate for a document type that has none, like a contract", () => {
    const built = buildReportContext({
      roles: [CONTRATO],
      bindings: [{ roleKey: "contrato", extractions: [{ id: "c1", data: { prazo: "12 meses" } }] }],
      meta: META,
    });
    expect(built.context["totais"]).toEqual({});
  });
});

describe("todayInSaoPaulo", () => {
  it("is dd/mm/aaaa in local time, not UTC", () => {
    // 2026-08-21T01:00Z is still 20/08 in São Paulo (UTC-3). `toISOString`
    // would name tomorrow on every report issued after 21:00 local.
    expect(todayInSaoPaulo(new Date("2026-08-21T01:00:00Z"))).toBe("20/08/2026");
  });
});
