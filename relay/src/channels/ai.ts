// relay/src/channels/ai.ts
//
// The `ai` channel: the relay's first, and the one the provider adapter
// registry hangs off (decisions §6).
//
// It does exactly four things, and deliberately nothing else:
//
//   1. resolves WHICH key this job may use            (secrets.ts, §12.7)
//   2. resolves WHICH adapter                          (providers/registry.ts)
//   3. turns a document reference into bytes           (S3 → base64)
//   4. hands both to the adapter and returns its result verbatim
//
// It does not choose a model, does not read the database (it cannot — non-VPC),
// does not decide what to extract, and does not interpret the answer. That is
// the dumb-sender rule from relay_lambda.md, and it is what keeps the API's
// half of §6 honest: the API composes the whole request, so a provider swap is
// a change of adapter rather than a change of pipeline.
//
// All four job KINDS (detect / extract / analyse / verify) run through this one
// function. §12.13 is explicit that the adversarial verify hop "runs through
// the same relay adapter registry — it is just another job kind", so `kind` is
// carried for logging and never branched on. A `switch (job.kind)` here would
// be the first crack in that.

import type { AiJob } from "../job";
import { getAdapter } from "../providers/registry";
import type { AdapterDocument, AdapterRequest, AiResult } from "../providers/types";
import { resolveApiKey } from "../secrets";
import { docsBucket, readBase64 } from "../s3";

/** The only content type the documents bucket is meant to hold (§12.5), and
 * the only one the pipeline produces. Fixed here rather than carried on the
 * payload: a caller-chosen MIME type is a caller-chosen provider behaviour. */
const DOCUMENT_MIME = "application/pdf";

/**
 * Resolves the document reference to something an adapter can attach.
 *
 * The S3 read happens HERE and not in an adapter, so the tenant boundary is
 * crossed in one place. `job.document.s3Key` was already proven to sit under
 * `job.tenantId` by `parseJob`, and `job.tenantId` came from the job KEY rather
 * than from the payload — that chain is the entire defence against a relay
 * that holds s3:GetObject on every tenant's PDFs reading the wrong one.
 */
async function resolveDocument(job: AiJob): Promise<AdapterDocument | undefined> {
  const doc = job.document;
  if (doc === undefined) {
    return undefined;
  }
  if ("s3Key" in doc) {
    return {
      kind: "inline",
      mimeType: DOCUMENT_MIME,
      data: await readBase64(docsBucket(), doc.s3Key),
    };
  }
  return { kind: "hosted", mimeType: DOCUMENT_MIME, fileId: doc.fileId };
}

export async function aiChannel(job: AiJob): Promise<AiResult> {
  // Resolved before the document is read: an unknown provider or a refused
  // parameter path is permanent, and there is no reason to spend an S3 read
  // (or the memory of a 25 MB PDF) to find that out.
  const adapter = getAdapter(job.provider);
  const apiKey = await resolveApiKey(job);
  const document = await resolveDocument(job);

  const req: AdapterRequest = {
    system: job.system,
    prompt: job.prompt,
    model: job.model,
    maxTokens: job.maxTokens,
    ...(job.schema === undefined ? {} : { schema: job.schema }),
    ...(document === undefined ? {} : { document }),
  };

  return adapter.send(req, apiKey);
}
