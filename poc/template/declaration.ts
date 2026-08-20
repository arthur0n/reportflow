/**
 * §3.2 — an outbound template DECLARES its named inputs and its prose slots.
 *
 * Documents are addressed BY ROLE, never by index. `docs[0]` cannot tell an
 * invoice from a contract, and flattening every document into one namespace
 * collides silently on shared field names like `total` — both `fatura.totais`
 * and a hypothetical `contrato.total` would fight for the same key.
 *
 * Because the roles are declared, "aguardando: contrato" is a real, showable
 * state instead of a report that renders with a silent hole in it.
 */

export interface RoleDeclaration {
  readonly key: string;
  readonly provider: string;
  readonly documentType: string;
  readonly cardinality: "one" | "many";
  readonly required: boolean;
}

export interface SlotDeclaration {
  readonly slug: string;
  /** Stored WITH the slot (§3.2). This is what hop 2 is given, per slot. */
  readonly guideline: string;
  readonly maxWords: number;
}

export interface OutboundTemplate {
  readonly name: string;
  readonly file: string;
  readonly version: number;
  readonly roles: readonly RoleDeclaration[];
  readonly slots: readonly SlotDeclaration[];
}

const ROLES: readonly RoleDeclaration[] = [
  {
    key: "faturas",
    provider: "House Living",
    documentType: "fatura",
    cardinality: "many",
    required: true,
  },
  {
    key: "contrato",
    provider: "House Living",
    documentType: "contrato",
    cardinality: "one",
    // optional on purpose: the report is useful without it, and `{{#if contrato}}`
    // is what keeps the missing case from leaving a hole.
    required: false,
  },
];

const SLOT_NOTAS: SlotDeclaration = {
  slug: "notas_executivas",
  guideline: [
    "Escreva as notas da secretaria executiva, em português do Brasil, tom formal e sóbrio.",
    "Comente: a composição da despesa do período (o que é honorário contratual recorrente e o que é serviço avulso),",
    "qualquer item extraordinário ou não recorrente, e a aderência entre o que o contrato prevê e o que foi faturado.",
    "Use APENAS números que constem das extrações fornecidas e reproduza-os exatamente como aparecem.",
    "Não invente datas, não estime valores, não projete cenários que os dados não suportem.",
    "Se algo parecer inconsistente entre contrato e faturas, aponte como observação e não como conclusão.",
    "Um ou dois parágrafos. Texto corrido, sem marcadores, sem títulos, sem HTML.",
  ].join(" "),
  maxWords: 180,
};

const SLOT_ACOMP: SlotDeclaration = {
  slug: "acompanhamento",
  guideline: [
    "Escreva o parágrafo de acompanhamento executivo, em português do Brasil.",
    "Resuma o total do período e o que deve ser observado no próximo ciclo",
    "(por exemplo: a próxima retribuição contratual devida, conforme a periodicidade do contrato).",
    "Use APENAS os valores e as datas presentes nas extrações. Nada de previsões numéricas novas.",
    "Um único parágrafo, texto corrido, sem marcadores, sem HTML.",
  ].join(" "),
  maxWords: 120,
};

export const TEMPLATE_FIEL: OutboundTemplate = {
  name: "Relatório de Gestão Locatícia — fiel",
  file: "fiel.hbs",
  version: 1,
  roles: ROLES,
  slots: [SLOT_NOTAS, SLOT_ACOMP],
};

export const TEMPLATE_MELHORADO: OutboundTemplate = {
  name: "Relatório de Gestão Locatícia — melhorado",
  file: "melhorado.hbs",
  version: 1,
  roles: ROLES,
  slots: [SLOT_NOTAS, SLOT_ACOMP],
};

export const ALL_SLOTS: readonly SlotDeclaration[] = [SLOT_NOTAS, SLOT_ACOMP];
