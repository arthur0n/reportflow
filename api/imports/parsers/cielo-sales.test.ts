import { describe, it, expect } from "vitest";
import { cieloSalesParser } from "./cielo-sales";
import { ofxParser } from "./ofx";

// Anonymized fixture mirroring the real "Detalhado de vendas" layout:
// latin-1, CRLF, preamble + Totalizador + 42-column header.
const HEADER_42 =
  "Data da venda;Hora da venda;Estabelecimento;Forma de pagamento;Bandeira;Valor bruto;Valor Taxa/Tarifa;Valor líquido;Status da venda;Tipo de lançamento;Motivo;Data do lançamento;Data prevista do pagamento;Código de autorização;NSU/DOC;Código da venda;TID;Origem do cartão;ID Pix;TxID;ID de pagamento Pix;Número do cartão;Número do pedido;Nota fiscal;Número do lote;Canal da venda;Modalidade;Tipo de captura;Número da máquina;Total de taxas;Taxa administrativa (MDR);Taxa do prazo de recebimento;Valor da taxa administrativa (MDR);Valor da taxa do prazo de recebimento;Valor do saque;Valor do troco;Origem do valor;Documento de origem;Instituição de origem;Destino do valor;Documento de destino;Instituição de destino";

function row(fields: Record<number, string>): string {
  const cols = new Array<string>(42).fill("");
  for (const [i, v] of Object.entries(fields)) cols[Number(i)] = v;
  return cols.join(";");
}

const FIXTURE_TEXT = [
  "Ouvidoria",
  "Usuário: FULANO DE TAL",
  "Estabelecimento: 1234567890",
  "CPF/CNPJ: 00.000.000/0001-00",
  "Detalhado de vendas Cielo",
  "Filtros:",
  "Data da venda: 01/07/2026 à 03/07/2026",
  "Totalizador",
  "Quantidade de vendas;Valor bruto;Taxa/tarifa;Valor líquido",
  "3;300,00;-5,00;295,00",
  HEADER_42,
  row({
    0: "01/07/2026",
    1: "12:46",
    2: "1234567890",
    3: "Pix",
    4: "Pix",
    5: "27,51",
    6: "-0,08",
    7: "27,43",
    8: "Aprovada",
    9: "Venda Pix",
    11: "01/07/2026",
    12: "01/07/2026",
    13: "000000",
    14: "1278316",
    18: "E165015552026070115465",
    19: "CIELO2026070100001278316",
  }),
  row({
    0: "01/07/2026",
    1: "13:32",
    2: "1234567890",
    3: "Débito à vista",
    4: "Visa",
    5: "178,77",
    6: "-1,59",
    7: "177,18",
    8: "Aprovada",
    9: "Venda débito",
    11: "01/07/2026",
    12: "02/07/2026",
    13: "022741",
    14: "709109",
    15: "2607010110020828263",
  }),
  row({
    0: "02/07/2026",
    1: "20:01",
    2: "1234567890",
    3: "Crédito à vista",
    4: "Mastercard",
    5: "100,00",
    6: "-3,00",
    7: "97,00",
    8: "Cancelada",
    9: "Venda crédito",
    11: "02/07/2026",
    12: "03/07/2026",
    13: "111111",
    14: "999999",
    15: "2607020210000000001",
  }),
].join("\r\n");

const FIXTURE = Buffer.from(FIXTURE_TEXT, "latin1");

async function collectRows(buffer: Buffer) {
  const rows = [];
  for await (const r of cieloSalesParser.parse(buffer)) rows.push(r);
  return rows;
}

describe("cieloSalesParser (detalhado)", () => {
  it("claims the detalhado CSV and rejects OFX + resumo layouts", () => {
    expect(cieloSalesParser.detect(FIXTURE)).toBe(true);
    expect(cieloSalesParser.detect(Buffer.from("OFXHEADER:100\n<OFX>"))).toBe(false);
    expect(ofxParser.detect(Buffer.from("OFXHEADER:100\n<OFX>"))).toBe(true);
    expect(cieloSalesParser.detect(Buffer.from("Consolidado de vendas Cielo\n", "latin1"))).toBe(
      false,
    );
  });

  it("extracts merchant, tax id and period", () => {
    const header = cieloSalesParser.extractHeader(FIXTURE);
    expect(header.accountRef).toBe("1234567890");
    expect(header.merchantTaxId).toBe("00.000.000/0001-00");
    expect(header.periodStart).toBe("2026-07-01");
    expect(header.periodEnd).toBe("2026-07-02");
  });

  it("emits one per-sale row with the declared settlement fields", async () => {
    const rows = await collectRows(FIXTURE);
    expect(rows[0]).toMatchObject({
      kind: "ok",
      normalized: {
        actualDate: "2026-07-01",
        actualAmount: 2743,
        externalId: "cielo:1234567890:CIELO2026070100001278316",
        acquirerSale: {
          merchantAccount: "1234567890",
          saleTime: "12:46",
          method: "Pix",
          brand: "Pix",
          grossAmount: 2751,
          feeAmount: -8,
          netAmount: 2743,
          expectedPaymentDate: "2026-07-01",
          nsu: "1278316",
          saleCode: "CIELO2026070100001278316",
          txId: "E165015552026070115465",
        },
      },
    });
    expect(rows[1]).toMatchObject({
      kind: "ok",
      normalized: {
        acquirerSale: {
          method: "Débito à vista",
          brand: "Visa",
          netAmount: 17718,
          expectedPaymentDate: "2026-07-02",
          txId: null,
        },
      },
    });
  });

  it("turns non-Aprovada sales into error rows carrying the status", async () => {
    const rows = await collectRows(FIXTURE);
    expect(rows[2]).toMatchObject({ kind: "error", error: "status: Cancelada" });
  });
});
