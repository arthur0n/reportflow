// app/src/features/extraction/extraction-draft.test.ts
//
// The two conversions that bracket the repair screen. They are worth a suite
// because the bugs they can hide are invisible on screen and fatal at save
// time: an emptied optional written as an ABSENT key instead of `null` fails
// `strictObject` for a reason the human cannot see, and a money value
// "helpfully" parsed to a number loses the cent §3.1 exists to protect.

import { describe, it, expect } from "vitest";
import type { FieldSpec } from "@shared/validation/field-spec";
import { validateExtraction } from "@shared/validation/extraction-validation";
import { dataToDraft, draftToData, emptyRow } from "./extraction-draft";

const FIELDS: readonly FieldSpec[] = [
  { name: "numero", type: "string", required: true, description: "nº" },
  { name: "iliquido", type: "money", required: true, description: "total" },
  { name: "paginas", type: "integer", required: false, description: "páginas" },
  { name: "observacao", type: "string", required: false, description: "obs" },
  {
    name: "itens",
    type: "object[]",
    required: true,
    description: "linhas",
    fields: [
      { name: "descricao", type: "string", required: true, description: "descrição" },
      { name: "total", type: "money", required: true, description: "total" },
    ],
  },
];

const DATA = {
  numero: "FT 1",
  iliquido: "1.234,56 €",
  paginas: 3,
  observacao: null,
  itens: [{ descricao: "Serviço", total: "617,28 €" }],
};

describe("dataToDraft / draftToData", () => {
  it("round-trips a valid payload unchanged", () => {
    expect(draftToData(FIELDS, dataToDraft(FIELDS, DATA))).toEqual(DATA);
  });

  // §3.1 — the money STRING is the value. Anything that turns it into a
  // number here has already lost the guarantee.
  it("keeps money verbatim and never converts it", () => {
    const out = draftToData(FIELDS, dataToDraft(FIELDS, DATA));
    expect(out["iliquido"]).toBe("1.234,56 €");
  });

  it("converts integer/decimal fields back to numbers", () => {
    expect(draftToData(FIELDS, dataToDraft(FIELDS, DATA))["paginas"]).toBe(3);
  });

  // `strictObject` treats an absent key and a null one as different facts; the
  // frozen schema wants null.
  it("writes an emptied optional as null, never as an absent key", () => {
    const out = draftToData(FIELDS, dataToDraft(FIELDS, { ...DATA, observacao: "" }));
    expect(Object.keys(out)).toContain("observacao");
    expect(out["observacao"]).toBeNull();
    expect(validateExtraction(FIELDS, out).ok).toBe(true);
  });

  // The draft is built from the FROZEN LIST, not from the payload's keys —
  // a field the model failed to return is exactly what the human is here to
  // fill in, and iterating the payload would render every field but that one.
  it("renders a field the payload never carried", () => {
    const draft = dataToDraft(FIELDS, { numero: "FT 1" });
    expect(Object.keys(draft)).toEqual(FIELDS.map((f) => f.name));
    expect(draft["iliquido"]).toBe("");
  });

  // A number the human typed badly must reach the validator as something it
  // can flag, not as NaN (which serialises to null and would read as
  // "ausente") or a silent 0.
  it("hands an unparseable number through as a string so it is flagged invalid", () => {
    const draft = dataToDraft(FIELDS, { ...DATA, paginas: 3 });
    const out = draftToData(FIELDS, { ...draft, paginas: "três" });
    expect(out["paginas"]).toBe("três");
    expect(validateExtraction(FIELDS, out).ok).toBe(false);
  });

  it("accepts a comma as the decimal separator", () => {
    const draft = dataToDraft(FIELDS, DATA);
    expect(draftToData(FIELDS, { ...draft, paginas: "3,5" })["paginas"]).toBe(3.5);
  });

  it("builds an empty line-item row with every subfield present", () => {
    expect(emptyRow(FIELDS[4]?.fields ?? [])).toEqual({ descricao: "", total: "" });
  });

  it("survives a payload that is not an object at all", () => {
    expect(() => draftToData(FIELDS, dataToDraft(FIELDS, "lixo"))).not.toThrow();
  });
});
