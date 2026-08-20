import "dotenv/config";
import { defineConfig } from "drizzle-kit";

// Bypass SSL certificate validation for RDS
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

function resolveConnectionString(): string {
  const { DATABASE_URL, DB_HOST, DB_USER, DB_PASSWORD, DB_NAME } = process.env;
  if (DATABASE_URL !== undefined && DATABASE_URL.length > 0) return DATABASE_URL;
  if (
    DB_HOST !== undefined &&
    DB_USER !== undefined &&
    DB_PASSWORD !== undefined &&
    DB_NAME !== undefined
  ) {
    return `postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}/${DB_NAME}?ssl=true`;
  }
  throw new Error(
    "Database connection required. Set DATABASE_URL or DB_HOST/DB_USER/DB_PASSWORD/DB_NAME",
  );
}

export default defineConfig({
  schema: "./drizzle/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: resolveConnectionString(),
    ssl: "require",
  },
});
