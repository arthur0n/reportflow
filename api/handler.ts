// api/handler.ts
//
// Lambda entry point. Dispatches:
//   1. OPTIONS preflight → CORS 200
//   2. POST /webhooks/clerk → webhook handler (before tRPC, no auth required)
//   3. anything else → tRPC adapter

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
  Context,
} from "aws-lambda";
import { awsLambdaRequestHandler } from "@trpc/server/adapters/aws-lambda";
import { createContext } from "./trpc/context";
import { appRouter } from "./trpc/router";
import { logTrpcError } from "./trpc/log-error";
import { handleWebhookRoutes } from "./routes/webhook-routes";
import { eq } from "drizzle-orm";
import { db } from "./db/client";
import { statementImports, tenants } from "../drizzle/schema";
import {
  isS3UploadEvent,
  uploadEventRefs,
  loadUploadFile,
  type UploadObjectRef,
} from "./imports/async-dispatch";
import { processImport, transitionStatus } from "./imports/orchestrator";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, svix-id, svix-timestamp, svix-signature",
};

const trpcHandler = awsLambdaRequestHandler({
  router: appRouter,
  createContext,
  onError: logTrpcError,
});

// S3 ObjectCreated on uploads/ — parse the file the upload mutation stored.
// Identity comes from the key; actor and industry come from the import row.
// Only `uploaded_pending` rows are processed, so replayed S3 events no-op.
async function handleUploadCreated(ref: UploadObjectRef): Promise<void> {
  const [imp] = await db
    .select({
      status: statementImports.status,
      userId: statementImports.userId,
      industry: tenants.industry,
    })
    .from(statementImports)
    .innerJoin(tenants, eq(tenants.id, statementImports.tenantId))
    .where(eq(statementImports.id, ref.importId))
    .limit(1);

  if (imp?.status !== "uploaded_pending") return;

  try {
    const fileBuffer = await loadUploadFile(ref.s3Key);
    await processImport(ref.importId, fileBuffer, ref.tenantId, imp.userId, imp.industry);
  } catch (err) {
    console.error("[process-import] failed:", err);
    await transitionStatus(ref.importId, ref.tenantId, "parsing", "parse_failed", null, {
      errorMessage: "processing_failed",
      parsedAt: new Date().toISOString(),
    });
  }
}

export const handler = async (
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyStructuredResultV2> => {
  if (isS3UploadEvent(event)) {
    for (const ref of uploadEventRefs(event)) {
      await handleUploadCreated(ref);
    }
    return { statusCode: 200, body: "" };
  }

  const { method, path } = event.requestContext.http;

  if (method === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  const webhookResult = await handleWebhookRoutes(method, path, event.body ?? "", event.headers);
  if (webhookResult) {
    return { ...webhookResult, headers: { ...webhookResult.headers, ...CORS_HEADERS } };
  }

  const response = await trpcHandler(event, context);
  return {
    ...response,
    headers: { ...response.headers, ...CORS_HEADERS },
  };
};

export type AppRouter = typeof appRouter;
