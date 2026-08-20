// api/services/documents-crud.ts
//
// The DB-touching half of the upload path (decisions §8, §12.5). The router
// stays thin — it validates the key and the object, then calls here.
//
// Two things live in this file rather than in the router:
//
//   1. Cross-tenant reference ownership. `documents.client_id` and
//      `documents.document_type_id` are ordinary uuid FKs with no tenant
//      column of their own on the FK target's identity — a bare FK happily
//      accepts another tenant's row id. assertReferencesOwnedByTenant
//      re-proves ownership before either is allowed into a documents row,
//      the same shape as resolveNewParent in tenant-values.router.ts.
//
//   2. Idempotent insert. `documents.s3_key` is UNIQUE (globally, not per
//      tenant — the key already carries the tenant prefix). confirmUpload can
//      be retried (a client that never saw the response, a duplicate submit),
//      and a retry must return the SAME row rather than erroring on the
//      unique constraint — hence ON CONFLICT DO NOTHING + a fallback read.

import { TRPCError } from "@trpc/server";
import { and, desc, eq, isNull } from "drizzle-orm";
import { clients, documentTypes, documents } from "../../drizzle/schema";
import type { db } from "../db/client";
import { withSystemFields } from "../db/scope";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DbLike = typeof db | Tx;

export type DocumentsCtx = { tenantId: string; userId: string };

export type DocumentRow = typeof documents.$inferSelect;

export type InsertDocumentInput = {
  s3Key: string;
  fileName?: string | null;
  byteSize?: number | null;
  clientId?: string | null;
  documentTypeId?: string | null;
};

export type InsertDocumentOutcome = { row: DocumentRow; created: boolean };

/**
 * Confirms `clientId`/`documentTypeId`, when provided, actually belong to
 * `tenantId` (and are not soft-deleted). Throws BAD_REQUEST otherwise.
 */
export async function assertReferencesOwnedByTenant(
  dbHandle: DbLike,
  tenantId: string,
  refs: { clientId?: string | null; documentTypeId?: string | null },
): Promise<void> {
  if (refs.clientId !== undefined && refs.clientId !== null) {
    const [row] = await dbHandle
      .select({ id: clients.id })
      .from(clients)
      .where(
        and(
          eq(clients.id, refs.clientId),
          eq(clients.tenantId, tenantId),
          isNull(clients.deletedAt),
        ),
      )
      .limit(1);
    if (!row) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Cliente inválido." });
    }
  }

  if (refs.documentTypeId !== undefined && refs.documentTypeId !== null) {
    const [row] = await dbHandle
      .select({ id: documentTypes.id })
      .from(documentTypes)
      .where(
        and(
          eq(documentTypes.id, refs.documentTypeId),
          eq(documentTypes.tenantId, tenantId),
          isNull(documentTypes.deletedAt),
        ),
      )
      .limit(1);
    if (!row) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "Tipo de documento inválido." });
    }
  }
}

/**
 * Inserts a documents row, or returns the row that already won the race on
 * `s3_key`. Idempotent on `s3_key` — the point of the exercise, since
 * confirmUpload can be retried and must not error or duplicate on a replay.
 */
export async function insertDocumentIdempotent(
  dbHandle: DbLike,
  ctx: DocumentsCtx,
  input: InsertDocumentInput,
): Promise<InsertDocumentOutcome> {
  const stamped = withSystemFields({ userId: ctx.userId }, "create", {
    tenantId: ctx.tenantId,
    s3Key: input.s3Key,
    fileName: input.fileName ?? null,
    byteSize: input.byteSize ?? null,
    clientId: input.clientId ?? null,
    documentTypeId: input.documentTypeId ?? null,
  });

  const inserted = await dbHandle
    .insert(documents)
    .values(stamped)
    .onConflictDoNothing({ target: documents.s3Key })
    .returning();

  const insertedRow = inserted[0];
  if (insertedRow !== undefined) {
    return { row: insertedRow, created: true };
  }

  // Lost the race (or this IS the replay) — read back the row that won.
  const [existing] = await dbHandle
    .select()
    .from(documents)
    .where(and(eq(documents.s3Key, input.s3Key), eq(documents.tenantId, ctx.tenantId)))
    .limit(1);

  if (existing === undefined) {
    // The conflict fired but no row is visible under THIS tenant. Keys are
    // minted under the caller's own prefix (api/lib/storage.ts), so a
    // cross-tenant collision should be impossible short of a uuid collision —
    // refuse rather than silently handing back nothing.
    throw new TRPCError({
      code: "CONFLICT",
      message: "Este arquivo já foi enviado por outra conta.",
    });
  }

  return { row: existing, created: false };
}

/** The tenant's documents, newest first. Soft-deleted rows excluded. */
export async function listDocuments(dbHandle: DbLike, tenantId: string): Promise<DocumentRow[]> {
  return dbHandle
    .select()
    .from(documents)
    .where(and(eq(documents.tenantId, tenantId), isNull(documents.deletedAt)))
    .orderBy(desc(documents.createdAt));
}
