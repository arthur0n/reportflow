// api/imports/parsers/cielo-sales.ts
//
// Cielo "Detalhado de vendas" CSV — one row per INDIVIDUAL sale, carrying
// the acquirer's own settlement declaration ("Data prevista do pagamento"),
// bandeira, NSU and the sale code used for dedup and portal lookup. Only
// this detailed layout is supported: the summary export ("Consolidado")
// aggregates by day×method and cannot be conciliated per sale.
//
// File shape (latin-1, CRLF, ';' delimiter):
//   preamble (contact info, "Estabelecimento:", "CPF/CNPJ:",
//   "Detalhado de vendas Cielo", filters, a Totalizador section)
//   header:  Data da venda;Hora da venda;Estabelecimento;Forma de pagamento;
//            Bandeira;Valor bruto;Valor Taxa/Tarifa;Valor líquido;Status...
//   rows:    01/07/2026;12:46;2762811877;Pix;Pix;27,51;-0,08;27,43;Aprovada;...

import type { Parser, ParsedRow, StatementHeader } from "./types";
import { parseAmountBR, parseDateBR, normalizeDescriptionBR } from "../locales/br";

const DELIMITER = ";";
const DAILY_HEADER_PREFIX = "data da venda;hora da venda";
const DETECT_SIGNATURE = /detalhado de vendas cielo/i;
const DATE_ROW = /^\d{2}\/\d{2}\/\d{4}$/;

const COLUMNS = {
  date: 0,
  time: 1,
  merchantAccount: 2,
  method: 3,
  brand: 4,
  gross: 5,
  fee: 6,
  net: 7,
  status: 8,
  expectedPaymentDate: 12,
  nsu: 14,
  saleCode: 15,
  pixId: 18,
  pixPaymentId: 19,
} as const;

// Cielo exports are CP1252/ISO-8859-1; latin1 maps those bytes 1:1.
function contentLines(buffer: Buffer): string[] {
  return buffer
    .toString("latin1")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
}

function dataRows(lines: string[]): string[] {
  const headerIdx = lines.findIndex((l) => l.toLowerCase().startsWith(DAILY_HEADER_PREFIX));
  if (headerIdx === -1) return [];
  return lines.slice(headerIdx + 1).filter((l) => DATE_ROW.test(l.split(DELIMITER)[0] ?? ""));
}

function optional(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

type RequiredSaleFields = {
  dateRaw: string;
  methodRaw: string;
  netRaw: string;
  merchantAccount: string;
  previstaRaw: string;
  saleCode: string;
};

// Only settled-able sales enter the ledger; anything else surfaces as an
// error row carrying the acquirer's own status. Card sales carry "Código da
// venda"; pix sales leave it empty and are identified by their pix ids.
function requireSaleFields(fields: string[]): RequiredSaleFields {
  const status = fields[COLUMNS.status] ?? "";
  if (status !== "Aprovada") throw new Error(`status: ${status}`);
  const dateRaw = optional(fields[COLUMNS.date]);
  if (dateRaw === null) throw new Error("missing date");
  const methodRaw = optional(fields[COLUMNS.method]);
  if (methodRaw === null) throw new Error("missing method");
  const netRaw = optional(fields[COLUMNS.net]);
  if (netRaw === null) throw new Error("missing net amount");
  const merchantAccount = optional(fields[COLUMNS.merchantAccount]);
  if (merchantAccount === null) throw new Error("missing merchant account");
  const previstaRaw = optional(fields[COLUMNS.expectedPaymentDate]);
  if (previstaRaw === null) throw new Error("missing expected payment date");
  const saleCode =
    optional(fields[COLUMNS.saleCode]) ??
    optional(fields[COLUMNS.pixPaymentId]) ??
    optional(fields[COLUMNS.pixId]);
  if (saleCode === null) throw new Error("missing sale code");
  return { dateRaw, methodRaw, netRaw, merchantAccount, previstaRaw, saleCode };
}

function parseDataLine(line: string, lineNumber: number): ParsedRow {
  const fields = line.split(DELIMITER).map((f) => f.trim());
  const raw: Record<string, unknown> = { line, lineNumber };

  try {
    const { dateRaw, methodRaw, netRaw, merchantAccount, previstaRaw, saleCode } =
      requireSaleFields(fields);

    const actualDate = parseDateBR(dateRaw);
    const method = normalizeDescriptionBR(methodRaw);
    const brand = optional(fields[COLUMNS.brand]);
    const actualAmount = parseAmountBR(netRaw);
    const grossRaw = fields[COLUMNS.gross];
    const feeRaw = fields[COLUMNS.fee];

    const acquirerSale = {
      merchantAccount,
      saleTime: optional(fields[COLUMNS.time]),
      method,
      brand,
      grossAmount: grossRaw !== undefined && grossRaw.length > 0 ? parseAmountBR(grossRaw) : 0,
      feeAmount: feeRaw !== undefined && feeRaw.length > 0 ? parseAmountBR(feeRaw) : 0,
      netAmount: actualAmount,
      expectedPaymentDate: parseDateBR(previstaRaw),
      nsu: optional(fields[COLUMNS.nsu]),
      saleCode,
      txId: optional(fields[COLUMNS.pixId]),
    };

    return {
      kind: "ok",
      raw,
      normalized: {
        actualDate,
        actualAmount,
        description: normalizeDescriptionBR(
          `Venda Cielo — ${methodRaw}${brand !== null && brand !== methodRaw ? ` ${brand}` : ""}`,
        ),
        externalId: `cielo:${merchantAccount}:${saleCode}`,
        reference: null,
        acquirerSale,
      },
    };
  } catch (err) {
    return { kind: "error", raw, error: err instanceof Error ? err.message : String(err) };
  }
}

export const cieloSalesParser: Parser = {
  format: "cielo_sales_detail_csv",
  kind: "card",
  acquirer: "cielo",

  detect(buffer: Buffer): boolean {
    const head = buffer.subarray(0, 2048).toString("latin1");
    if (/OFXHEADER:|<OFX>/i.test(head)) return false;
    return DETECT_SIGNATURE.test(head);
  },

  extractHeader(buffer: Buffer): StatementHeader {
    const lines = contentLines(buffer);
    const merchant = lines.map((l) => /^Estabelecimento:\s*(\d+)/.exec(l)).find((m) => m !== null);
    // "CPF/CNPJ: 63.735.376/0001-64" — self-referenced pix deposits carry it.
    const taxId = lines.map((l) => /^CPF\/CNPJ:\s*([\d./-]+)/.exec(l)).find((m) => m !== null);

    let periodStart: string | null = null;
    let periodEnd: string | null = null;
    for (const row of dataRows(lines)) {
      const dateRaw = row.split(DELIMITER)[0] ?? "";
      try {
        const iso = parseDateBR(dateRaw.trim());
        if (periodStart === null || iso < periodStart) periodStart = iso;
        if (periodEnd === null || iso > periodEnd) periodEnd = iso;
      } catch {
        continue;
      }
    }

    return {
      bankRoutingCode: null,
      accountRef: merchant?.[1] ?? null,
      periodStart,
      periodEnd,
      currency: "BRL",
      merchantTaxId: taxId?.[1] ?? null,
    };
  },

  async *parse(buffer: Buffer): AsyncIterable<ParsedRow> {
    const rows = dataRows(contentLines(buffer));
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row === undefined) continue;
      yield parseDataLine(row, i + 1);
    }
  },
};
