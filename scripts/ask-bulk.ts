// scripts/ask-bulk.ts
//
// Bulk import for the dev-phase Q&A tracker. Reads a JSON file with shape
// { items: [...] } and inserts every item in a single transaction. Items
// may include answer/answeredBy/status — pre-resolved questions land in
// the tracker already marked "answered".
//
// Usage:
//   pnpm ask:bulk docs/backlog/01-gaps-and-questions.json
//   pnpm ask:bulk docs/backlog/01-gaps-and-questions.json --reset
//   pnpm ask:bulk docs/backlog/02-m01-ledger.json --feature=transacoes
//
// --reset:           TRUNCATE the table and restart the ref sequence at 1
//                    BEFORE inserting. Destructive — dev-only reseed.
// --feature=<slug>:  override the feature for ALL imported items, ignoring
//                    any value in the JSON or auto-extraction from the title.

import "dotenv/config";
import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { z } from "zod/v4";
import { questionsAndFeedback } from "../drizzle/schema";
import {
  CreateQuestionInput,
  QuestionRole,
  QuestionStatus,
} from "../shared/validation/question-schemas";

/**
 * Extract a feature slug from a title prefix like "FLUXO — ..." or
 * "CONCILIAÇÃO BANCÁRIA — ...". Returns null when no em-dash prefix is
 * present. Lowercases, strips accents, collapses whitespace to single
 * underscore. Keeps things readable (`evolucao_custos`, `conciliacao_bancaria`).
 */
function extractFeature(title: string): string | null {
  const idx = title.indexOf(" — ");
  if (idx === -1) return null;
  const prefix = title.slice(0, idx).trim();
  if (prefix.length === 0) return null;
  const slug = prefix
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug.length > 0 && slug.length <= 50 ? slug : null;
}

const BulkItem = CreateQuestionInput.extend({
  answer: z.string().trim().min(1).max(10_000).optional(),
  answeredBy: QuestionRole.optional(),
  status: QuestionStatus.optional(),
}).superRefine((v, ctx) => {
  if (v.answer !== undefined && v.answeredBy === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["answeredBy"],
      message: "answeredBy is required when answer is set",
    });
  }
});

const BulkFile = z.object({ items: z.array(BulkItem).min(1) });

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const reset = args.includes("--reset");
  const featureOverrideFlag = args.find((a) => a.startsWith("--feature="));
  const featureOverride = featureOverrideFlag?.slice("--feature=".length);
  const filePath = args.find((a) => !a.startsWith("--"));
  if (filePath === undefined || filePath.length === 0) {
    console.error("Usage: pnpm ask:bulk <path-to-json> [--reset] [--feature=<slug>]");
    process.exit(1);
  }
  if (featureOverride?.length === 0) {
    console.error("[ask:bulk] --feature requires a non-empty value");
    process.exit(1);
  }

  const raw: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  const parsed = BulkFile.safeParse(raw);
  if (!parsed.success) {
    console.error("[ask:bulk] invalid JSON:");
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

    if (reset) {
      await db.execute(sql`TRUNCATE TABLE questions_and_feedback RESTART IDENTITY`);
      console.warn("[ask:bulk] ⚠ truncated existing rows; ref sequence restarted at 1");
    }

    const now = new Date().toISOString();

    const rows = parsed.data.items.map((it) => {
      const hasAnswer = it.answer !== undefined;
      const status = it.status ?? (hasAnswer ? "answered" : "open");
      const feature = featureOverride ?? it.feature ?? extractFeature(it.title);
      return {
        kind: it.kind,
        title: it.title,
        body: it.body,
        owner: it.owner,
        author: it.author,
        status,
        ...(feature !== null && { feature }),
        ...(hasAnswer && {
          answer: it.answer,
          answeredBy: it.answeredBy,
          answeredAt: now,
        }),
      };
    });

    const inserted = await db
      .insert(questionsAndFeedback)
      .values(rows)
      .returning({ id: questionsAndFeedback.id, ref: questionsAndFeedback.ref });

    const answered = rows.filter((r) => r.status !== "open").length;
    const refs = inserted.map((r) => r.ref);
    const range = refs.length > 0 ? `#${Math.min(...refs)}–#${Math.max(...refs)}` : "—";
    console.warn(
      `[ask:bulk] ✓ inserted ${inserted.length} item(s) ${range} (${answered} pre-resolved, ${
        inserted.length - answered
      } open)`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error("[ask:bulk] ✗ failed:", err);
  process.exit(1);
});
