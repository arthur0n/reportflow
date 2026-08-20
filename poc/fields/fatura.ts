/**
 * Extract template: (provider = House Living, type = Fatura).
 * Hand-written stand-in for a frozen Calibrate output.
 *
 * input_mode "text": these PDFs carry a real text layer, so native-PDF vision
 * would be paying 5-20x for nothing (§3.1). We still send the PDF natively here
 * because the POC has no bundled text extractor yet (§12.2 spike is a separate
 * issue) — the flag is recorded so the cost decision is already expressed.
 *
 * NOTE on these documents: each PDF contains the SAME invoice three times
 * (Original / Duplicado / Triplicado). That is a per-provider quirk the field
 * list has to be told about, or the model happily returns three copies of every
 * line item. It is exactly the kind of thing Calibrate's human step exists for.
 */
import type { ExtractTemplate } from "./spec.ts";
import { buildZodSchema, type InferFields } from "./spec.ts";

export const FATURA_FIELDS = [
  {
    name: "numero",
    type: "string",
    required: true,
    description: 'Número da fatura como impresso, incluindo série e barra, ex.: "FT A2024/1".',
  },
  {
    name: "data",
    type: "date",
    required: true,
    description: 'Campo "Data Doc." — dd/mm/aaaa.',
  },
  {
    name: "cliente_nome",
    type: "string",
    required: true,
    // Tightened after a real miss: on one of thirteen invoices the model
    // returned the ENTIRE address block here — schema-valid (a non-empty
    // string) but semantically wrong. Zod cannot catch that, which is exactly
    // why §3.1 keeps a human-confirmed golden fixture alongside the field list.
    description:
      "APENAS a primeira linha do bloco de morada do adquirente, no topo do documento: o nome da pessoa, em maiúsculas. NÃO inclua a rua, o código postal, a cidade nem o país. NÃO é o emitente (House Living).",
  },
  {
    name: "cliente_numero",
    type: "string",
    required: true,
    description: 'Campo "Cliente Nº".',
  },
  {
    name: "contribuinte",
    type: "string",
    required: true,
    description:
      'NIF do adquirente — o campo "Contribuinte" da linha do cliente, NÃO o contribuinte do emitente no cabeçalho.',
  },
  {
    name: "cond_pagamento",
    type: "string",
    required: true,
    description: 'Campo "Cond. Pag.", ex.: "Pronto Pagamento".',
  },
  {
    name: "atendido_por",
    type: "string",
    required: false,
    description: 'Campo "Atendido por", se presente. null quando ausente.',
  },
  {
    name: "itens",
    type: "object[]",
    required: true,
    description:
      "Linhas da tabela Ref.ª/Descrição/Qtd/Und/Preço/%Iva/Total. ATENÇÃO: este PDF repete a MESMA fatura em Original, Duplicado e Triplicado — devolva as linhas UMA só vez, lidas do exemplar Original.",
    fields: [
      {
        name: "ref",
        type: "string",
        required: true,
        description: 'Código da coluna "Ref.ª", ex.: "LIMP", "FHS", "LAV", "CONS".',
      },
      {
        name: "descricao",
        type: "string",
        required: true,
        description:
          "Descrição da linha, incluindo a linha de detalhe imediatamente abaixo (local e data do serviço), numa só string.",
      },
      { name: "qtd", type: "decimal", required: true, description: "Coluna Qtd." },
      {
        name: "unidade",
        type: "string",
        required: true,
        description: 'Coluna "Und", ex.: "Unidad".',
      },
      { name: "preco", type: "money", required: true, description: "Coluna Preço, verbatim." },
      {
        name: "iva_pct",
        type: "decimal",
        required: true,
        description: "Coluna %Iva como número, ex.: 23.",
      },
      {
        name: "total",
        type: "money",
        required: true,
        description: "Coluna Total da linha, verbatim.",
      },
    ],
  },
  {
    name: "totais",
    type: "object",
    required: true,
    description: "Bloco de totais no rodapé.",
    fields: [
      {
        name: "iliquido",
        type: "money",
        required: true,
        description: '"Total Ilíquido", verbatim.',
      },
      { name: "iva", type: "money", required: true, description: '"Total Iva", verbatim.' },
      {
        name: "documento",
        type: "money",
        required: true,
        description: '"Total Documento", verbatim.',
      },
      { name: "a_pagar", type: "money", required: true, description: '"Total a Pagar", verbatim.' },
    ],
  },
  {
    name: "iban",
    type: "string",
    required: true,
    description: 'IBAN do bloco "Para Transferências Utilize os Dados", sem espaços.',
  },
  {
    name: "page",
    type: "integer",
    required: true,
    description:
      "§6.1 — página (1-based) de onde os totais foram lidos. Auto-declarado pelo modelo: structured output e citations não coexistem, ficámos com o schema.",
  },
] as const satisfies ExtractTemplate["fields"];

export const FATURA_TEMPLATE: ExtractTemplate = {
  documentType: "fatura",
  provider: "House Living",
  inputMode: "text",
  detectHint: ["Administração de Imóveis", "Cond. Pag.", "Total Ilíquido"],
  fields: FATURA_FIELDS,
  calibrationRev: 1,
};

export const faturaSchema = buildZodSchema(FATURA_FIELDS);
export type Fatura = InferFields<typeof FATURA_FIELDS>;
