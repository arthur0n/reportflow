// scripts/ask.ts
//
// CLI for the AI to file a question / bug / feedback into the dev-phase
// tracker. Writes directly through Drizzle using the DB env vars (no Clerk
// auth path). Invoked by `pnpm ask`.
//
// Usage:
//   pnpm ask --kind=question --owner=po --title="..." --body="..."
//   pnpm ask --kind=bug --owner=se --feature=fluxo --title="..." --body="..."
//
// Defaults: --author=ai, --kind=question. --owner is required.
// --feature is an optional free-text tag (lowercase slug recommended).

import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { questionsAndFeedback } from "../drizzle/schema";
import { CreateQuestionInput } from "../shared/validation/question-schemas";

type Flags = Record<string, string>;

function parseFlags(argv: string[]): Flags {
  const out: Flags = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq === -1) {
      out[arg.slice(2)] = "true";
    } else {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    }
  }
  return out;
}

function require_(flags: Flags, name: string): string {
  const v = flags[name];
  if (v === undefined || v.length === 0) {
    console.error(`[ask] missing required flag --${name}`);
    process.exit(1);
  }
  return v;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));

  const parsed = CreateQuestionInput.safeParse({
    kind: flags["kind"] ?? "question",
    title: require_(flags, "title"),
    body: require_(flags, "body"),
    owner: require_(flags, "owner"),
    author: flags["author"] ?? "ai",
    ...(flags["feature"] !== undefined && { feature: flags["feature"] }),
  });

  if (!parsed.success) {
    console.error("[ask] invalid input:");
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }

  const connectionString =
    process.env["DATABASE_URL"] ??
    `postgresql://${process.env["DB_USER"]}:${process.env["DB_PASSWORD"]}@${process.env["DB_HOST"]}/${process.env["DB_NAME"]}`;

  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 1,
  });

  try {
    const db = drizzle(pool, { schema: { questionsAndFeedback } });
    const [row] = await db.insert(questionsAndFeedback).values(parsed.data).returning();
    if (!row) {
      throw new Error("insert returned no row");
    }
    const url = process.env["VITE_APP_URL"] ?? "http://localhost:5173";
    console.warn(`[ask] ✓ created #${row.ref}  (${row.id})`);
    console.warn(`     → ${url}/feedback`);
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error("[ask] ✗ failed:", err);
  process.exit(1);
});
