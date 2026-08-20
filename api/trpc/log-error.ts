// api/trpc/log-error.ts
//
// tRPC onError hook. Without this, drizzle errors in production reach the
// client as the generic `DrizzleQueryError("Failed query: ...")` with the
// real cause stripped during JSON serialization — the Lambda logs are
// silent. This hook surfaces the underlying pg / runtime error to
// CloudWatch and to the dev-server stdout. Expected user-facing errors
// (4xx) are not logged so the channel stays useful.

import type { TRPCError } from "@trpc/server";
import { DrizzleQueryError } from "drizzle-orm/errors";

type LogArgs = {
  error: TRPCError;
  type: "query" | "mutation" | "subscription" | "unknown";
  path: string | undefined;
};

const SILENT_CODES = new Set<TRPCError["code"]>([
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "PRECONDITION_FAILED",
  "UNPROCESSABLE_CONTENT",
  "TOO_MANY_REQUESTS",
]);

export function logTrpcError({ error, type, path }: LogArgs): void {
  if (SILENT_CODES.has(error.code)) return;

  const cause = error.cause;
  const dbCause =
    cause instanceof DrizzleQueryError && cause.cause instanceof Error ? cause.cause : undefined;

  const lines = [`[trpc] ${type} ${path ?? "<unknown>"} ${error.code}: ${error.message}`];
  if (cause instanceof Error) {
    lines.push(`  cause: ${cause.message}`);
  }
  if (dbCause) {
    lines.push(`  db cause: ${dbCause.message}`);
  }

  // Pass the original cause as the second console.error arg so the runtime
  // attaches its stack trace (CloudWatch shows it on the next line).
  console.error(lines.join("\n"), cause ?? error);
}
