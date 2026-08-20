// api/imports/parsers/types.ts
//
// Shared types for the import parser pipeline.

export type NormalizedTxn = {
  actualDate: string; // ISO date (YYYY-MM-DD)
  actualAmount: number; // signed cents (positive = credit, negative = debit)
  description: string;
  externalId: string | null; // e.g. 'ofx:santander:243344'
  // Free-text identifier surfaced from source-format fields like OFX
  // CHECKNUM/REFNUM. Trimmed and capped at 80 chars to match the column.
  reference: string | null;
  // Acquirer-report rows only: the fields promoted into acquirer_sales
  // (G-02, one row per individual sale). Bank parsers leave it undefined.
  acquirerSale?: {
    merchantAccount: string; // acquirer's establishment id — scopes saleCode
    saleTime: string | null; // "HH:mm"
    method: string;
    brand: string | null; // bandeira (Visa/Mastercard/Elo/Pix)
    grossAmount: number; // cents
    feeAmount: number; // cents (negative: fee reduces gross)
    netAmount: number; // cents
    expectedPaymentDate: string; // ISO — the acquirer's declared settlement date
    nsu: string | null;
    saleCode: string; // acquirer's unique sale id within the merchant account
    txId: string | null; // pix end-to-end id
  };
};

export type ParsedRow =
  | { kind: "ok"; raw: Record<string, unknown>; normalized: NormalizedTxn }
  | { kind: "error"; raw: Record<string, unknown>; error: string };

export type StatementHeader = {
  bankRoutingCode: string | null; // raw routing identifier (OFX <BANKID>); resolved to a BANK_SLUG by the orchestrator
  accountRef: string | null; // OFX <ACCTID>
  periodStart: string | null; // ISO date
  periodEnd: string | null; // ISO date
  currency: string; // e.g. 'BRL'
  // Merchant CPF/CNPJ from acquirer-report headers; null for bank files.
  // Keys the pix_day_sum rule (self-referenced QR-sale deposits).
  merchantTaxId: string | null;
};

export interface Parser {
  format: string;
  // Semantic side of the file, written to statement_imports.source_kind:
  // 'bank' statements promote to transactions via review/approve, 'card'
  // acquirer reports promote to acquirer_sales and skip the classifier chain.
  kind: "bank" | "card";
  // ACQUIRER LOV code for acquirer-report parsers ('cielo'); null for banks.
  acquirer: string | null;
  detect(buffer: Buffer): boolean;
  parse(buffer: Buffer): AsyncIterable<ParsedRow>;
  extractHeader(buffer: Buffer): StatementHeader;
}
