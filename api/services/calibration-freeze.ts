// api/services/calibration-freeze.ts
//
// The FREEZE half of Calibrate (decisions §3.1, §12.8) — split out of
// calibration-service.ts only because the two halves together outgrow this
// repo's 500-line file limit. The seam is a real one: everything here WRITES,
// everything there proposes or reads.
//
// It is the only writer of the input axis — providers → document_types →
// extract_templates → extract_fields — and of the golden fixture, and it runs
// inside the transaction the router opens, so a rev bump with no fields (or
// fields with no template) is not a state that can exist. §12.8 has no
// extract-template versioning to roll back to, which is exactly why the write
// has to be atomic in the first place.
//
// GOLDEN FIXTURE, and where its two halves live (§3.1: "sample PDF +
// human-confirmed JSON"). The PDF half is `extract_templates.fixture_s3_key`,
// which is the sample document's own `s3_key` — the object already exists,
// already sits under the tenant's prefix, and copying it would create a second
// object that can rot. The JSON half goes into `extractions`, at the
// template's NEW `calibration_rev`, with `corrected = true`. That table is not
// a compromise, it is the right home: it is DEFINED as the validated
// extraction JSON keyed by `unique(s3_key, calibration_rev)` (§12.8), and
// `corrected` already means exactly what a confirmed fixture is — "a human
// fixed this; it is permanent and free, never re-run" (§4.2). The fixture
// therefore doubles as a warm cache entry, so the calibration sample is the
// one document this tenant is never billed to extract. A dedicated `fixtures`
// table would have restated the cache key, the rev semantics and the JSON
// column to express the same fact with none of that behaviour.

import { TRPCError } from "@trpc/server";
import { and, eq, isNull } from "drizzle-orm";
import {
  documentTypes,
  documents,
  extractFields,
  extractTemplates,
  extractions,
  providers,
} from "../../drizzle/schema";
import type { DbLike } from "../collector/job-state";
import { withSystemFields } from "../db/scope";
import {
  buildZodSchema,
  flattenFieldTree,
  type FieldSpec,
  type InputMode,
} from "../../shared/validation/field-spec";
import type { FreezeCalibrationInputT } from "../../shared/validation/calibration-schemas";
import {
  loadOwnedDocument,
  loadOwnedProviderName,
  type CalibrationCtx,
} from "./calibration-service";

// ---------------------------------------------------------------------------
// freeze — create-or-reuse the axis, replace the field list, store the fixture
// ---------------------------------------------------------------------------

type NameOrId = { readonly id: string } | { readonly name: string };

/**
 * Read-then-insert rather than `ON CONFLICT`: the unique indexes on
 * `providers` and `document_types` are PARTIAL (`WHERE deleted_at IS NULL`),
 * so inferring them from an upsert means restating the predicate at every call
 * site and getting it wrong once. Freeze runs inside a transaction and is a
 * deliberate, human-driven act — the race this gives up is two people
 * calibrating the same new provider in the same second, which the unique index
 * still catches as an error rather than as a duplicate row.
 */
async function resolveProvider(
  dbHandle: DbLike,
  ctx: CalibrationCtx,
  ref: NameOrId,
): Promise<string> {
  if ("id" in ref) {
    await loadOwnedProviderName(dbHandle, ctx.tenantId, ref.id);
    return ref.id;
  }
  const existing = await dbHandle
    .select({ id: providers.id })
    .from(providers)
    .where(
      and(
        eq(providers.tenantId, ctx.tenantId),
        eq(providers.name, ref.name),
        isNull(providers.deletedAt),
      ),
    )
    .limit(1);
  const found = existing[0];
  if (found !== undefined) {
    return found.id;
  }
  const inserted = await dbHandle
    .insert(providers)
    .values(
      withSystemFields({ userId: ctx.userId }, "create", {
        tenantId: ctx.tenantId,
        name: ref.name,
      }),
    )
    .returning({ id: providers.id });
  const row = inserted[0];
  if (row === undefined) {
    throw new Error("resolveProvider: providers insert returned no row");
  }
  return row.id;
}

/** Same shape, plus the check that an id the client sent belongs to the
 * provider it also sent — `document_types` is unique on (provider_id, name),
 * so a type id from another provider would silently re-parent the template. */
async function resolveDocumentType(
  dbHandle: DbLike,
  ctx: CalibrationCtx,
  providerId: string,
  ref: NameOrId,
): Promise<string> {
  if ("id" in ref) {
    const owned = await dbHandle
      .select({ id: documentTypes.id })
      .from(documentTypes)
      .where(
        and(
          eq(documentTypes.id, ref.id),
          eq(documentTypes.tenantId, ctx.tenantId),
          eq(documentTypes.providerId, providerId),
          isNull(documentTypes.deletedAt),
        ),
      )
      .limit(1);
    if (owned[0] === undefined) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Tipo de documento inválido." });
    }
    return ref.id;
  }
  const existing = await dbHandle
    .select({ id: documentTypes.id })
    .from(documentTypes)
    .where(
      and(
        eq(documentTypes.providerId, providerId),
        eq(documentTypes.tenantId, ctx.tenantId),
        eq(documentTypes.name, ref.name),
        isNull(documentTypes.deletedAt),
      ),
    )
    .limit(1);
  const found = existing[0];
  if (found !== undefined) {
    return found.id;
  }
  const inserted = await dbHandle
    .insert(documentTypes)
    .values(
      withSystemFields({ userId: ctx.userId }, "create", {
        tenantId: ctx.tenantId,
        providerId,
        name: ref.name,
      }),
    )
    .returning({ id: documentTypes.id });
  const row = inserted[0];
  if (row === undefined) {
    throw new Error("resolveDocumentType: document_types insert returned no row");
  }
  return row.id;
}

/**
 * Upserts the ONE live template for this document type and returns it.
 *
 * §12.8, decided: invalidate. There is no extract-template versioning — a
 * recalibration BUMPS `calibration_rev`, which participates in the extraction
 * cache key `unique(s3_key, calibration_rev)`. That single increment is the
 * whole staleness mechanism: nothing is deleted, nothing is flagged, and every
 * affected document simply misses the cache and re-extracts (re-billed) on
 * next use. There is deliberately nothing else to do here.
 */
async function upsertTemplate(
  dbHandle: DbLike,
  ctx: CalibrationCtx,
  documentTypeId: string,
  values: { inputMode: InputMode; detectHint: readonly string[]; fixtureS3Key: string },
): Promise<{
  readonly id: string;
  readonly calibrationRev: number;
  readonly recalibrated: boolean;
}> {
  const existing = await dbHandle
    .select({ id: extractTemplates.id, calibrationRev: extractTemplates.calibrationRev })
    .from(extractTemplates)
    .where(
      and(
        eq(extractTemplates.documentTypeId, documentTypeId),
        eq(extractTemplates.tenantId, ctx.tenantId),
        isNull(extractTemplates.deletedAt),
      ),
    )
    .limit(1);

  const live = existing[0];
  if (live === undefined) {
    const inserted = await dbHandle
      .insert(extractTemplates)
      .values(
        withSystemFields({ userId: ctx.userId }, "create", {
          tenantId: ctx.tenantId,
          documentTypeId,
          inputMode: values.inputMode,
          detectHint: [...values.detectHint],
          fixtureS3Key: values.fixtureS3Key,
          calibrationRev: 1,
        }),
      )
      .returning({ id: extractTemplates.id });
    const row = inserted[0];
    if (row === undefined) {
      throw new Error("upsertTemplate: extract_templates insert returned no row");
    }
    return { id: row.id, calibrationRev: 1, recalibrated: false };
  }

  const nextRev = live.calibrationRev + 1;
  await dbHandle
    .update(extractTemplates)
    .set(
      withSystemFields({ userId: ctx.userId }, "update", {
        inputMode: values.inputMode,
        detectHint: [...values.detectHint],
        fixtureS3Key: values.fixtureS3Key,
        calibrationRev: nextRev,
      }),
    )
    .where(and(eq(extractTemplates.id, live.id), eq(extractTemplates.tenantId, ctx.tenantId)));
  return { id: live.id, calibrationRev: nextRev, recalibrated: true };
}

/**
 * Replace-all. The frozen list is a WHOLE — a partial diff would leave a
 * template whose fields came from two different calibrations, which is exactly
 * the versioning §12.8 refused.
 *
 * SOFT-delete, not DELETE: `extract_fields` is registered `softDelete: true`
 * (api/db/scope.ts), the two unique indexes are partial on `deleted_at IS
 * NULL` so the old names free up immediately. Note: under §12.8's
 * recalibrate-INVALIDATES semantics, extractions at the previous rev are
 * stale — they are re-run on next use, never re-read — so the old field list
 * does not need to remain queryable; the soft-deleted rows are audit trail,
 * not a live contract.
 */
async function replaceFields(
  dbHandle: DbLike,
  ctx: CalibrationCtx,
  templateId: string,
  fields: readonly FieldSpec[],
): Promise<number> {
  const now = new Date().toISOString();
  await dbHandle
    .update(extractFields)
    .set({ deletedAt: now, deletedBy: ctx.userId, lastUpdAt: now, lastUpdBy: ctx.userId })
    .where(
      and(
        eq(extractFields.extractTemplateId, templateId),
        eq(extractFields.tenantId, ctx.tenantId),
        isNull(extractFields.deletedAt),
      ),
    );

  // `flattenFieldTree` emits parents before their children, so one pass can
  // resolve `parentKey` against ids Postgres has already handed back.
  const flat = flattenFieldTree(fields);
  const idByKey = new Map<string, string>();
  for (const node of flat) {
    const parentId = node.parentKey === null ? null : (idByKey.get(node.parentKey) ?? null);
    const inserted = await dbHandle
      .insert(extractFields)
      .values(
        withSystemFields({ userId: ctx.userId }, "create", {
          tenantId: ctx.tenantId,
          extractTemplateId: templateId,
          parentFieldId: parentId,
          name: node.name,
          type: node.type,
          required: node.required,
          description: node.description,
          sortOrder: node.sortOrder,
        }),
      )
      .returning({ id: extractFields.id });
    const row = inserted[0];
    if (row === undefined) {
      throw new Error(`replaceFields: extract_fields insert returned no row for ${node.key}`);
    }
    idByKey.set(node.key, row.id);
  }
  return flat.length;
}

export interface FreezeOutcome {
  readonly providerId: string;
  readonly documentTypeId: string;
  readonly templateId: string;
  readonly calibrationRev: number;
  /** True when this replaced a live template — §12.8's rev bump happened and
   * every existing extraction of this type is now stale. */
  readonly recalibrated: boolean;
  readonly fieldCount: number;
  /** Whether the human-confirmed JSON half of the golden fixture was stored,
   * and why not when it was not. The PDF half always is (it is the sample's
   * own key), so only this half can fail. */
  readonly fixtureJsonStored: boolean;
  readonly fixtureJsonSkippedReason?: string;
}

/**
 * The freeze. Runs inside the caller's transaction (the router opens it) so a
 * half-frozen template — a rev bump with no fields, or fields with no
 * template — cannot exist.
 */
export async function freezeCalibration(
  dbHandle: DbLike,
  ctx: CalibrationCtx,
  input: FreezeCalibrationInputT,
): Promise<FreezeOutcome> {
  const sample = await loadOwnedDocument(dbHandle, ctx.tenantId, input.sampleDocumentId);
  const providerId = await resolveProvider(dbHandle, ctx, input.provider);
  const documentTypeId = await resolveDocumentType(dbHandle, ctx, providerId, input.documentType);

  const template = await upsertTemplate(dbHandle, ctx, documentTypeId, {
    inputMode: input.inputMode,
    detectHint: input.detectHint,
    fixtureS3Key: sample.s3Key,
  });
  const fieldCount = await replaceFields(dbHandle, ctx, template.id, input.fields);

  // The human just declared what this document IS — that is tier 3's answer
  // (§3.3), arrived at through a different door, and `manual` is the one value
  // no later detection may overwrite.
  await dbHandle
    .update(documents)
    .set(
      withSystemFields({ userId: ctx.userId }, "update", { documentTypeId, detectedBy: "manual" }),
    )
    .where(and(eq(documents.id, sample.id), eq(documents.tenantId, ctx.tenantId)));

  const fixture = await storeFixtureJson(dbHandle, ctx, {
    documentId: sample.id,
    s3Key: sample.s3Key,
    templateId: template.id,
    calibrationRev: template.calibrationRev,
    fields: input.fields,
    confirmedJson: input.confirmedJson,
  });

  return {
    providerId,
    documentTypeId,
    templateId: template.id,
    calibrationRev: template.calibrationRev,
    recalibrated: template.recalibrated,
    fieldCount,
    ...fixture,
  };
}

/**
 * The JSON half of the golden fixture.
 *
 * VALIDATED AGAINST THE FROZEN LIST, not against the proposed one: the human
 * may have renamed a field after the model filled in the sample values, and a
 * fixture that does not satisfy the schema every future extraction is checked
 * by is not a fixture — it is a trap that would "catch" provider drift that
 * never happened. A mismatch skips the row and SAYS SO, rather than failing
 * the freeze (the template is the primary artifact and is already correct) or
 * writing the values anyway.
 */
async function storeFixtureJson(
  dbHandle: DbLike,
  ctx: CalibrationCtx,
  args: {
    documentId: string;
    s3Key: string;
    templateId: string;
    calibrationRev: number;
    fields: readonly FieldSpec[];
    confirmedJson: Record<string, unknown> | undefined;
  },
): Promise<{ fixtureJsonStored: boolean; fixtureJsonSkippedReason?: string }> {
  if (args.confirmedJson === undefined) {
    return {
      fixtureJsonStored: false,
      fixtureJsonSkippedReason: "Nenhum JSON confirmado enviado.",
    };
  }
  const validated = buildZodSchema(args.fields).safeParse(args.confirmedJson);
  if (!validated.success) {
    return {
      fixtureJsonStored: false,
      fixtureJsonSkippedReason: "O JSON confirmado não corresponde à lista de campos congelada.",
    };
  }

  const inserted = await dbHandle
    .insert(extractions)
    .values({
      tenantId: ctx.tenantId,
      documentId: args.documentId,
      extractTemplateId: args.templateId,
      s3Key: args.s3Key,
      calibrationRev: args.calibrationRev,
      data: validated.data,
      // No provider/model: a human confirmed these values. Attributing them to
      // the model that drafted them would make the fixture look like a paid
      // extraction in the one place we go to check what a model produced.
      corrected: true,
      createdAt: new Date().toISOString(),
      createdBy: ctx.userId,
      lastUpdAt: new Date().toISOString(),
      lastUpdBy: ctx.userId,
    })
    .onConflictDoNothing({ target: [extractions.s3Key, extractions.calibrationRev] })
    .returning({ id: extractions.id });

  return inserted.length === 1
    ? { fixtureJsonStored: true }
    : {
        fixtureJsonStored: false,
        fixtureJsonSkippedReason: "Já existe uma extração deste ficheiro nesta calibração.",
      };
}
