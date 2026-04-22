import * as dotenv from "dotenv";
import type { Config } from "drizzle-kit";

// drizzle-kit runs outside of Next.js, so it won't auto-load .env.local.
// We load it explicitly here so DATABASE_URL is available during migrations.
dotenv.config({ path: ".env.local" });

export default {
  schema: "./lib/db/schema/index.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env["DATABASE_URL"]!,
  },
} satisfies Config;
