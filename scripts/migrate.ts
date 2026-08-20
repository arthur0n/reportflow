// scripts/migrate.ts
//
// Applies drizzle migrations via drizzle-orm's programmatic migrate()
// function. Preferred over `drizzle-kit migrate` because it gives actual
// error messages when something fails. Invoked by `pnpm db:migrate`.

import "dotenv/config";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

async function main(): Promise<void> {
  const connectionString =
    process.env["DATABASE_URL"] ??
    `postgresql://${process.env["DB_USER"]}:${process.env["DB_PASSWORD"]}@${process.env["DB_HOST"]}/${process.env["DB_NAME"]}`;

  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
    max: 1,
  });

  try {
    const db = drizzle(pool);
    console.warn("[migrate] applying migrations from ./drizzle");
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.warn("[migrate] ✓ done");
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error("[migrate] ✗ failed:", err);
  process.exit(1);
});
