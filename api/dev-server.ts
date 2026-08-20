// api/dev-server.ts
//
// Local development server. Wraps the *real* appRouter in an Express app so
// local dev exercises the same routes the Lambda does. Auth works too: if
// you pass a valid Clerk JWT in the Authorization header, protectedProcedure
// calls succeed (assuming the users row exists).

import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { appRouter } from "./trpc/router";
import { createExpressContext } from "./trpc/context";
import { logTrpcError } from "./trpc/log-error";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => {
        resolve(true);
      });
    });
    server.on("error", () => {
      resolve(false);
    });
  });
}

async function findAvailablePort(startPort = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer(): Promise<void> {
  const app = express();
  const server = createServer(app);

  app.use(express.json({ limit: "10mb" }));

  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext: createExpressContext,
      onError: logTrpcError,
    }),
  );

  const preferredPort = Number.parseInt(process.env.PORT ?? "3001", 10);
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.warn(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.warn(`[API] Dev server running on http://localhost:${port}/`);
    console.warn(`[API] tRPC endpoint:       http://localhost:${port}/api/trpc`);
  });
}

startServer().catch((err) => {
  console.error("[API] Failed to start dev server", err);
  process.exit(1);
});
