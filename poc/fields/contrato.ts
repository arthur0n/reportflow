/**
 * Extract template: (provider = House Living, type = Contrato).
 *
 * SAME provider, DIFFERENT document type, DIFFERENT field list — this is the
 * concrete case §3.1 is written about, and the reason Calibrate keys on TYPE.
 *
 * input_mode "vision", and not as a preference: this contract is a 4-page Ricoh
 * scan with a ZERO-byte text layer (`pdftotext` returns 4 bytes). Tier-1
 * substring detection (§3.3) is therefore impossible for it and falls through to
 * tier 2 — exactly the fallthrough §12.2 describes. The fatura next door stays
 * on the cheap path. No shared fallback ladder; per-type cost decision.
 *
 * Lean on purpose: a report needs the honorarium, the term, and the duty list.
 * It does not need the passport number, the spouse's NIF, or the CPF that are
 * also on page 1 — see §12.4, extraction values are untrusted content, and PII
 * you never extract is PII you can never leak into a client-facing document.
 */
import type { ExtractTemplate } from "./spec.ts";
import { buildZodSchema, type InferFields } from "./spec.ts";

export const CONTRATO_FIELDS = [
  {
    name: "titulo",
    type: "string",
    required: true,
    description: "Título do contrato tal como impresso no cabeçalho.",
  },
  {
    name: "parte_primeira",
    type: "string",
    required: true,
    description:
      'Nome do "Primeiro Contratante" (o proprietário). Apenas o nome — sem passaporte, sem CPF, sem cônjuge.',
  },
  {
    name: "parte_primeira_nif",
    type: "string",
    required: true,
    description: "NIF do Primeiro Contratante.",
  },
  {
    name: "parte_segunda",
    type: "string",
    required: true,
    description: "Denominação social da Segunda Contratante (a administradora).",
  },
  {
    name: "parte_segunda_nif",
    type: "string",
    required: true,
    description: "NIF / pessoa coletiva da Segunda Contratante.",
  },
  {
    name: "imovel_descricao",
    type: "string",
    required: true,
    description: "Descrição da fração autónoma nos Considerandos (letra, andar, tipologia).",
  },
  {
    name: "imovel_endereco",
    type: "string",
    required: true,
    description: "Morada do imóvel administrado.",
  },
  {
    name: "data_celebracao",
    type: "date",
    required: true,
    description: "Data de celebração no fecho do contrato, dd/mm/aaaa.",
  },
  {
    name: "prazo",
    type: "string",
    required: true,
    description: "Duração e regime de renovação, resumido numa frase (cláusula Sétima).",
  },
  {
    name: "denuncia_dias",
    type: "integer",
    required: true,
    description: "Antecedência mínima, em dias, para denúncia ou oposição à renovação.",
  },
  {
    name: "retribuicao_valor",
    type: "money",
    required: true,
    description: "Valor da retribuição da cláusula Quarta, verbatim, no formato de moeda europeu.",
  },
  {
    name: "retribuicao_periodicidade",
    type: "string",
    required: true,
    description: 'Periodicidade da retribuição, ex.: "semestral".',
  },
  {
    name: "retribuicao_nota",
    type: "string",
    required: true,
    description:
      "Condições associadas à retribuição: incidência de IVA, cadência de pagamento e prazo de vencimento da fatura.",
  },
  {
    name: "iban_pagamento",
    type: "string",
    required: true,
    description: "IBAN indicado na cláusula Quarta para liquidação da retribuição, sem espaços.",
  },
  {
    name: "banco_pagamento",
    type: "string",
    required: true,
    description: "Banco indicado na cláusula Quarta.",
  },
  {
    name: "obrigacoes_principais",
    type: "object[]",
    required: true,
    description:
      "Deveres da Segunda Contratante enumerados na cláusula Segunda. Uma entrada por marcador de topo.",
    fields: [
      {
        name: "titulo",
        type: "string",
        required: true,
        description: "Rótulo curto (2-5 palavras) para a obrigação.",
      },
      {
        name: "detalhe",
        type: "string",
        required: true,
        description: "A obrigação, parafraseada em uma frase.",
      },
      {
        name: "verificavel_por_fatura",
        type: "string",
        required: true,
        description:
          'Se o cumprimento desta obrigação é evidenciável pelas faturas do período: "sim" quando existe um serviço faturável correspondente, "nao" quando não.',
      },
    ],
  },
  {
    name: "page",
    type: "integer",
    required: true,
    description:
      "§6.1 — página (1-based) de onde a cláusula da retribuição foi lida. Auto-declarado.",
  },
] as const satisfies ExtractTemplate["fields"];

export const CONTRATO_TEMPLATE: ExtractTemplate = {
  documentType: "contrato",
  provider: "House Living",
  // scan, no text layer — tier 1 detection impossible, §3.3 falls through
  inputMode: "vision",
  detectHint: ["CONTRATO DE ADMINISTRAÇÃO DE BEM IMÓVEL"],
  fields: CONTRATO_FIELDS,
  calibrationRev: 1,
};

export const contratoSchema = buildZodSchema(CONTRATO_FIELDS);
export type Contrato = InferFields<typeof CONTRATO_FIELDS>;
