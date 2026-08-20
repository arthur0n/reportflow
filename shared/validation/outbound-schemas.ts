// shared/validation/outbound-schemas.ts
//
// The OUTPUT axis's wire shapes (decisions §3.2, §5.3, §12.4).
//
// Two things are validated here and NOTHING else: the ENVELOPE (names, ids,
// lengths, enums) and the two identifier grammars that the render context
// depends on. The template HTML itself is NOT validated by a Zod schema —
// it is validated by the §12.4 gate in api/render/handlebars.ts, on the parsed
// AST, which is the only thing that can tell `{{{x}}}` from `{{x}}`. A regex
// here would be a weaker second opinion that a reader would mistake for the
// real one.
//
// ROLE KEYS AND SLOT SLUGS ARE HANDLEBARS PATH SEGMENTS. A role becomes a
// top-level key in the render context (`{{nota.titular}}`), so it has to be a
// bare identifier — a key with a dot, a dash or a space is unreachable from a
// template, and a key called `meta` or `totais` would shadow the code-computed
// blocks the report renders its numbers from (§12.12b).

import { z } from "zod/v4";

/** A bare Handlebars path segment: what a role key and a slot slug must be. */
export const IDENTIFIER_RE = /^[a-z][a-z0-9_]{0,49}$/u;

/** Context keys owned by the deterministic layer (api/render/report-context.ts).
 * A role may not claim one — it would shadow the numbers with a document. */
export const RESERVED_ROLE_KEYS: readonly string[] = ["meta", "totais", "this"];

const IdentifierZ = z
  .string()
  .regex(IDENTIFIER_RE, "Use apenas letras minúsculas, números e _ (começando por letra).");

export const RoleKeyZ = IdentifierZ.refine((v) => !RESERVED_ROLE_KEYS.includes(v), {
  message: `Nome reservado. Não use: ${RESERVED_ROLE_KEYS.join(", ")}.`,
});

export const CardinalityZ = z.enum(["one", "many"]);
export type Cardinality = z.infer<typeof CardinalityZ>;

/**
 * What the AUTHOR declares: a role key bound to a document type, plus whether
 * the report can be published without it and how many documents may fill it.
 */
export const RoleInputZ = z.object({
  key: RoleKeyZ,
  documentTypeId: z.string().uuid(),
  cardinality: CardinalityZ,
  required: z.boolean(),
});
export type RoleInputT = z.infer<typeof RoleInputZ>;

/**
 * What is STORED in `outbound_template_versions.inputs_json`: the author's
 * declaration plus the provider/type NAMES resolved at save time.
 *
 * The names are denormalised on purpose. A version is immutable (§5.3) and a
 * document type can be renamed or soft-deleted afterwards; a version that
 * could only render its own inputs list by joining a row that may be gone is a
 * version whose declaration decays. `documentTypeId` stays authoritative for
 * the ATTACH check — the names are for the screen.
 */
export const RoleDeclarationZ = RoleInputZ.extend({
  provider: z.string().min(1).max(160),
  documentType: z.string().min(1).max(160),
});
export type RoleDeclarationT = z.infer<typeof RoleDeclarationZ>;

/** Guideline text is what hop 2 is given, per slot (§3.2). */
export const SlotInputZ = z.object({
  slug: IdentifierZ,
  guideline: z.string().max(4000).default(""),
  maxWords: z.number().int().min(20).max(2000).default(180),
});
export type SlotInputT = z.infer<typeof SlotInputZ>;

/** `outbound_template_versions.slots_json`. Same shape — the slugs are the
 * ones SCANNED from the HTML, never the ones the client claimed. */
export const SlotDeclarationZ = z.object({
  slug: IdentifierZ,
  guideline: z.string().max(4000),
  maxWords: z.number().int().min(20).max(2000),
});
export type SlotDeclarationT = z.infer<typeof SlotDeclarationZ>;

export const RoleDeclarationsZ = z.array(RoleDeclarationZ);
export const SlotDeclarationsZ = z.array(SlotDeclarationZ);

/** 200 KB of Handlebars. Generous for a print-grade A4 shell with its CSS
 * inline (poc/template/fiel.hbs is 10 KB), small enough that a paste accident
 * is refused before it reaches the parser. */
export const TEMPLATE_HTML_MAX = 200_000;

const TemplateHtmlZ = z.string().min(1, "O modelo não pode estar vazio.").max(TEMPLATE_HTML_MAX);

export const CreateOutboundTemplateInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullish(),
});
export type CreateOutboundTemplateInputT = z.infer<typeof CreateOutboundTemplateInput>;

export const OutboundTemplateIdInput = z.object({ templateId: z.string().uuid() });
export type OutboundTemplateIdInputT = z.infer<typeof OutboundTemplateIdInput>;

/**
 * Writes version N+1. There is deliberately no `version` field: the number is
 * the server's to assign, and a client-supplied one is a client-supplied
 * overwrite of an immutable row (§5.3).
 */
export const SaveTemplateVersionInput = z.object({
  templateId: z.string().uuid(),
  html: TemplateHtmlZ,
  inputs: z.array(RoleInputZ).max(12),
  slots: z.array(SlotInputZ).max(24).default([]),
});
export type SaveTemplateVersionInputT = z.infer<typeof SaveTemplateVersionInput>;

/**
 * Renders the UNSAVED textarea against the calibration fixtures — the §3.2
 * authoring loop. It takes the html directly rather than a version id because
 * the whole point is to see a template that has not been saved yet.
 */
export const PreviewTemplateInput = z.object({
  html: TemplateHtmlZ,
  inputs: z.array(RoleInputZ).max(12),
  slots: z.array(SlotInputZ).max(24).default([]),
});
export type PreviewTemplateInputT = z.infer<typeof PreviewTemplateInput>;
