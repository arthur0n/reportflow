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

export const handler = async (
  event: APIGatewayProxyEventV2,
  context: Context,
): Promise<APIGatewayProxyStructuredResultV2> => {
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
