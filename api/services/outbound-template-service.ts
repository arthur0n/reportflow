// api/services/outbound-template-service.ts
//
// The OUTPUT axis's authoring loop (decisions §3.2, §5.3, §12.4). Same split
// as every other service here: all DB access lives in this file so it can be
// unit-tested against a fake handle, and the router stays wiring.
//
// FOUR PROPERTIES THIS FILE OWNS.
//
// 1. THE SLOT LIST IS SCANNED, NOT DECLARED. `slots_json` comes from walking
//    the saved HTML for `{{ai "slug"}}` (api/render/handlebars.ts). A client
//    supplies GUIDELINES keyed by slug — the text hop 2 is given — and nothing
//    else. A declared-but-unused slot is prose nobody renders; a used-but-
//    undeclared slot is a hole the analysis was never asked to fill. Scanning
//    makes both unrepresentable instead of merely invalid.
//
// 2. A VERSION IS VALIDATED BEFORE IT EXISTS. The §12.4 gate runs on the AST,
//    and then the template is RENDERED against the calibration fixtures of the
//    declared roles. A gate-only check passes a template whose every `{{#each
//    nota.itens}}` names a field the frozen list does not have — strict mode
//    would only discover that on the first real report, at which point the
//    version is immutable and a draft may already point at it.
//
// 3. THE PREVIEW IS THE SAME CODE PATH. `preview` renders the UNSAVED textarea
//    through the identical builder, so "what the preview showed" and "what the
//    save validated" cannot diverge.
//
// 4. NOTHING UPDATES A VERSION. Saving writes N+1 (api/db/outbound-access.ts).

import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import { documentTypes, extractTemplates, extractions, providers } from "../../drizzle/schema";
import type { DbLike } from "../collector/job-state";
import {
  getOutboundTemplate,
  insertOutboundTemplate,
  insertTemplateVersion,
  listLatestVersions,
  listOutboundTemplateVersions,
  listOutboundTemplates,
  type OutboundTemplateVersionRow,
} from "../db/outbound-access";
import { renderTemplate, scanAiSlots, TemplateViolation } from "../render/handlebars";
import {
  buildReportContext,
  todayInSaoPaulo,
  type BoundExtraction,
  type RoleBinding,
} from "../render/report-context";
import {
  RoleDeclarationsZ,
  SlotDeclarationsZ,
  type CreateOutboundTemplateInputT,
  type RoleDeclarationT,
  type RoleInputT,
  type SaveTemplateVersionInputT,
  type SlotDeclarationT,
  type SlotInputT,
} from "../../shared/validation/outbound-schemas";

export interface OutboundCtx {
  readonly tenantId: string;
  readonly userId: string;
}

/** Placeholder prose so a layout is reviewable before hop 2 has ever run —
 * poc/render.ts's `PLACEHOLDER`, kept because the authoring loop depends on
 * seeing the shell before any analysis exists. */
export function slotPlaceholder(slug: string): string {
  return `[prosa do slot "${slug}" — será gerada pela análise]`;
}

// ---------------------------------------------------------------------------
// Reading a stored version back. jsonb is whatever was last written to it, so
// it is PARSED, not cast — including versions written by an older shape of
// this code.
// ---------------------------------------------------------------------------

export function parseRoles(raw: unknown): RoleDeclarationT[] {
  const parsed = RoleDeclarationsZ.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

export function parseSlots(raw: unknown): SlotDeclarationT[] {
  const parsed = SlotDeclarationsZ.safeParse(raw);
  return parsed.success ? parsed.data : [];
}

// ---------------------------------------------------------------------------
// Roles → provider/type names, under the caller's tenant
// ---------------------------------------------------------------------------

/**
 * Resolves each declared role's `document_type_id` to its provider/type NAMES,
 * refusing any type the caller does not own.
 *
 * The uuid the browser sent is a lookup key, never a permission: a type id
 * from another tenant is rejected here, not silently stamped into an immutable
 * version that would then leak the other tenant's naming through every
 * rendered report.
 */
export async function resolveRoles(
  dbHandle: DbLike,
  tenantId: string,
  inputs: readonly RoleInputT[],
): Promise<RoleDeclarationT[]> {
  const seen = new Set<string>();
  for (const input of inputs) {
    if (seen.has(input.key)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Papel duplicado: "${input.key}". Cada papel precisa de um nome único.`,
      });
    }
    seen.add(input.key);
  }

  const resolved: RoleDeclarationT[] = [];
  for (const input of inputs) {
    const [row] = await dbHandle
      .select({ typeName: documentTypes.name, providerName: providers.name })
      .from(documentTypes)
      .innerJoin(providers, eq(providers.id, documentTypes.providerId))
      .where(
        and(
          eq(documentTypes.id, input.documentTypeId),
          eq(documentTypes.tenantId, tenantId),
          isNull(documentTypes.deletedAt),
        ),
      )
      .limit(1);
    if (row === undefined) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `Tipo de documento inválido para o papel "${input.key}".`,
      });
    }
    resolved.push({ ...input, provider: row.providerName, documentType: row.typeName });
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// The calibration fixture, per role — §3.1's "sample PDF + human-confirmed
// JSON", reused as the preview's data.
// ---------------------------------------------------------------------------

/**
 * The confirmed fixture extraction for a role's document type, or null.
 *
 * It is the extraction stored by `freezeCalibration` at the template's CURRENT
 * `calibration_rev`, keyed by the template's own `fixture_s3_key` — the same
 * `unique(s3_key, calibration_rev)` row the extraction cache reads. Reusing it
 * rather than keeping a second copy is what makes the preview show data whose
 * shape a human actually confirmed (§3.1) instead of a hand-written stub that
 * drifts from the frozen field list the moment someone recalibrates.
 */
async function loadFixture(
  dbHandle: DbLike,
  tenantId: string,
  documentTypeId: string,
): Promise<BoundExtraction | null> {
  const [row] = await dbHandle
    .select({ id: extractions.id, data: extractions.data })
    .from(extractions)
    .innerJoin(extractTemplates, eq(extractTemplates.id, extractions.extractTemplateId))
    .where(
      and(
        eq(extractTemplates.documentTypeId, documentTypeId),
        eq(extractTemplates.tenantId, tenantId),
        isNull(extractTemplates.deletedAt),
        eq(extractions.tenantId, tenantId),
        eq(extractions.s3Key, extractTemplates.fixtureS3Key),
        eq(extractions.calibrationRev, extractTemplates.calibrationRev),
      ),
    )
    .limit(1);
  return row === undefined ? null : { id: row.id, data: row.data };
}

export interface FixtureContext {
  readonly bindings: readonly RoleBinding[];
  /** Roles with no confirmed fixture. The dry run is SKIPPED when this is
   * non-empty (see `validateTemplate`). */
  readonly rolesWithoutFixture: readonly string[];
}

export async function loadFixtureBindings(
  dbHandle: DbLike,
  tenantId: string,
  roles: readonly RoleDeclarationT[],
): Promise<FixtureContext> {
  const bindings: RoleBinding[] = [];
  const rolesWithoutFixture: string[] = [];
  for (const role of roles) {
    const fixture = await loadFixture(dbHandle, tenantId, role.documentTypeId);
    if (fixture === null) {
      rolesWithoutFixture.push(role.key);
      bindings.push({ roleKey: role.key, extractions: [] });
      continue;
    }
    // A `many` role gets TWO copies of the one fixture. One row makes an
    // `{{#each}}` render and hides every mistake that only shows up with more
    // than one — a stray separator, a total that is really the first row's
    // value, a `<tr>` closed outside the loop.
    bindings.push({
      roleKey: role.key,
      extractions: role.cardinality === "many" ? [fixture, fixture] : [fixture],
    });
  }
  return { bindings, rolesWithoutFixture };
}

// ---------------------------------------------------------------------------
// Validation: the §12.4 gate, the slot scan, and the fixture dry run
// ---------------------------------------------------------------------------

export type DryRun =
  { readonly status: "ok" } | { readonly status: "skipped"; readonly reason: string };

export interface TemplateValidation {
  readonly slots: SlotDeclarationT[];
  /** The dry run's OUTPUT, when it ran. `preview` returns this rather than
   * rendering a second time — one render means the preview and the validation
   * cannot disagree about what the template produces. */
  readonly renderedHtml: string | null;
  readonly dryRun: DryRun;
}

/** Turns a `TemplateViolation` (or a strict-mode render failure) into the
 * BAD_REQUEST the author sees. Both are the author's mistake, never a fault:
 * the message already names the line or the missing path. */
function asAuthorError(err: unknown, prefix: string): TRPCError {
  const message = err instanceof Error ? err.message : String(err);
  return new TRPCError({ code: "BAD_REQUEST", message: `${prefix}${message}` });
}

/**
 * Everything that must hold before an immutable row is written.
 *
 * `guidelines` is matched to the SCANNED slugs. A guideline for a slug that is
 * not in the HTML is refused rather than dropped — silently discarding it
 * would let an author write instructions for hop 2 that hop 2 never receives,
 * and the failure would only show up as bland prose weeks later.
 */
export function validateTemplate(args: {
  readonly html: string;
  readonly guidelines: readonly SlotInputT[];
  readonly roles: readonly RoleDeclarationT[];
  readonly fixtures: FixtureContext;
  readonly title: string;
}): TemplateValidation {
  let slugs: string[];
  try {
    slugs = scanAiSlots(args.html);
  } catch (err) {
    if (err instanceof TemplateViolation) {
      throw asAuthorError(err, "");
    }
    throw err;
  }

  const byslug = new Map(args.guidelines.map((g) => [g.slug, g]));
  for (const guideline of args.guidelines) {
    if (!slugs.includes(guideline.slug)) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          `A diretriz "${guideline.slug}" não corresponde a nenhum {{ai "${guideline.slug}"}} ` +
          `no modelo. Slots encontrados: ${slugs.length > 0 ? slugs.join(", ") : "nenhum"}.`,
      });
    }
  }
  const slots: SlotDeclarationT[] = slugs.map((slug) => {
    const supplied = byslug.get(slug);
    return {
      slug,
      guideline: supplied?.guideline ?? "",
      maxWords: supplied?.maxWords ?? 180,
    };
  });

  if (args.fixtures.rolesWithoutFixture.length > 0) {
    // NOT a refusal. A template is authored BEFORE the documents it will read
    // exist — refusing to save one because a role's type has no confirmed
    // sample yet would make the authoring loop depend on calibration order.
    // The §12.4 gate still ran, so what is skipped is the DATA check only, and
    // the caller reports which roles caused the skip.
    return {
      slots,
      renderedHtml: null,
      dryRun: {
        status: "skipped",
        reason:
          `Sem amostra confirmada para: ${args.fixtures.rolesWithoutFixture.join(", ")}. ` +
          `Calibre esses tipos para validar o modelo contra dados reais.`,
      },
    };
  }

  const built = buildReportContext({
    roles: args.roles,
    bindings: args.fixtures.bindings,
    meta: {
      titulo: args.title,
      cliente: "Cliente de exemplo",
      emissao: todayInSaoPaulo(),
      n_documentos: args.fixtures.bindings.reduce((n, b) => n + b.extractions.length, 0),
    },
  });

  let renderedHtml: string;
  try {
    renderedHtml = renderTemplate(args.html, built.context, {
      slots: {},
      missingSlotText: slotPlaceholder,
    });
  } catch (err) {
    throw asAuthorError(err, "O modelo não renderiza com a amostra calibrada: ");
  }

  return { slots, renderedHtml, dryRun: { status: "ok" } };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listTemplates(
  dbHandle: DbLike,
  tenantId: string,
): Promise<
  {
    id: string;
    name: string;
    description: string | null;
    system: boolean;
    latestVersionId: string | null;
    latestVersion: number | null;
  }[]
> {
  const [templates, latest] = await Promise.all([
    listOutboundTemplates(dbHandle, tenantId),
    listLatestVersions(dbHandle, tenantId),
  ]);
  const byTemplate = new Map(latest.map((l) => [l.templateId, l]));
  return templates.map((t) => {
    const version = byTemplate.get(t.id);
    return {
      id: t.id,
      name: t.name,
      description: t.description,
      system: t.tenantId === null,
      latestVersionId: version?.versionId ?? null,
      latestVersion: version?.version ?? null,
    };
  });
}

export interface TemplateDetail {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  /** System templates are visible to every org and editable by none of them
   * here — `saveVersion` refuses (see below). */
  readonly system: boolean;
  readonly versions: readonly { id: string; version: number; createdAt: string }[];
  readonly latest: {
    readonly id: string;
    readonly version: number;
    readonly html: string;
    readonly inputs: readonly RoleDeclarationT[];
    readonly slots: readonly SlotDeclarationT[];
  } | null;
}

export async function getTemplate(
  dbHandle: DbLike,
  tenantId: string,
  templateId: string,
): Promise<TemplateDetail> {
  const template = await getOutboundTemplate(dbHandle, tenantId, templateId);
  if (template === undefined) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Modelo não encontrado." });
  }
  const versions = await listOutboundTemplateVersions(dbHandle, tenantId, templateId);
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  const newest: OutboundTemplateVersionRow | undefined = sorted[0];
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    system: template.tenantId === null,
    versions: sorted.map((v) => ({ id: v.id, version: v.version, createdAt: v.createdAt })),
    latest:
      newest === undefined
        ? null
        : {
            id: newest.id,
            version: newest.version,
            html: newest.html,
            inputs: parseRoles(newest.inputsJson),
            slots: parseSlots(newest.slotsJson),
          },
  };
}

export async function createTemplate(
  dbHandle: DbLike,
  ctx: OutboundCtx,
  input: CreateOutboundTemplateInputT,
): Promise<{ id: string; name: string }> {
  const row = await insertOutboundTemplate(dbHandle, ctx, {
    name: input.name,
    description: input.description ?? null,
  });
  return { id: row.id, name: row.name };
}

export interface SaveVersionOutcome {
  readonly versionId: string;
  readonly version: number;
  readonly slots: readonly SlotDeclarationT[];
  readonly dryRun: DryRun;
}

/**
 * Writes version N+1 (§5.3). Runs inside the caller's transaction so the
 * version-number read and the insert cannot straddle another author's save.
 *
 * A SYSTEM template is refused. It is visible to every org through
 * `lovConditions(..., "combined")`, so a tenant-facing save on one would edit
 * a shared artifact from a tenant-scoped procedure — the one thing decisions
 * §2 says a wider menu must never become.
 */
export async function saveVersion(
  dbHandle: DbLike,
  ctx: OutboundCtx,
  input: SaveTemplateVersionInputT,
): Promise<SaveVersionOutcome> {
  const template = await getOutboundTemplate(dbHandle, ctx.tenantId, input.templateId);
  if (template === undefined) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Modelo não encontrado." });
  }
  if (template.tenantId === null) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Modelos do sistema não podem ser editados por uma conta.",
    });
  }

  const roles = await resolveRoles(dbHandle, ctx.tenantId, input.inputs);
  const fixtures = await loadFixtureBindings(dbHandle, ctx.tenantId, roles);
  const validated = validateTemplate({
    html: input.html,
    guidelines: input.slots,
    roles,
    fixtures,
    title: template.name,
  });

  const row = await insertTemplateVersion(dbHandle, ctx, {
    outboundTemplateId: input.templateId,
    html: input.html,
    slotsJson: validated.slots,
    inputsJson: roles,
  });

  return {
    versionId: row.id,
    version: row.version,
    slots: validated.slots,
    dryRun: validated.dryRun,
  };
}

export interface PreviewOutcome {
  readonly html: string;
  readonly slots: readonly SlotDeclarationT[];
  readonly dryRun: DryRun;
  readonly rolesWithoutFixture: readonly string[];
}

/**
 * Renders the unsaved textarea against the calibration fixtures — the `<iframe>`
 * half of §3.2's authoring UI.
 *
 * Returns HTML the client drops into a SANDBOXED `srcdoc` (§12.4). The
 * sandboxing is the client's job because it is a property of the frame, not of
 * the string; what this side guarantees is that the string was produced by the
 * one gated engine, with escaping on, from data the tenant already owns.
 */
export async function previewTemplate(
  dbHandle: DbLike,
  tenantId: string,
  input: {
    readonly html: string;
    readonly inputs: readonly RoleInputT[];
    readonly slots: readonly SlotInputT[];
  },
): Promise<PreviewOutcome> {
  const roles = await resolveRoles(dbHandle, tenantId, input.inputs);
  const fixtures = await loadFixtureBindings(dbHandle, tenantId, roles);
  const validated = validateTemplate({
    html: input.html,
    guidelines: input.slots,
    roles,
    fixtures,
    title: "Pré-visualização",
  });

  // The dry run already rendered when every role had a fixture. When some role
  // did NOT, render anyway against the empty role — the author still needs to
  // see the shell, and a strict-mode failure on an unfilled role is the
  // clearest possible statement of what is missing, provided the message says
  // so rather than blaming the sample.
  let html = validated.renderedHtml;
  if (html === null) {
    const built = buildReportContext({
      roles,
      bindings: fixtures.bindings,
      meta: {
        titulo: "Pré-visualização",
        cliente: "Cliente de exemplo",
        emissao: todayInSaoPaulo(),
        n_documentos: fixtures.bindings.reduce((n, b) => n + b.extractions.length, 0),
      },
    });
    try {
      html = renderTemplate(input.html, built.context, {
        slots: {},
        missingSlotText: slotPlaceholder,
      });
    } catch (err) {
      throw asAuthorError(
        err,
        `Pré-visualização sem amostra para: ${fixtures.rolesWithoutFixture.join(", ")}. `,
      );
    }
  }

  return {
    html,
    slots: validated.slots,
    dryRun: validated.dryRun,
    rolesWithoutFixture: fixtures.rolesWithoutFixture,
  };
}
