import { createEnv } from "@t3-oss/env-nextjs";
import { z } from "zod";

export const env = createEnv({
  /**
   * Server-side environment variables.
   * These are NOT exposed to the browser.
   */
  server: {
    DATABASE_URL: z
      .string()
      .url()
      .refine(
        (url) => url.startsWith("postgresql://") || url.startsWith("postgres://"),
        { message: "DATABASE_URL must be a valid PostgreSQL connection string" }
      ),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
    TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
    TELEGRAM_WEBHOOK_SECRET: z.string().min(1).optional(),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    TAVILY_API_KEY: z.string().min(1).optional(),
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
  },

  /**
   * Client-side environment variables.
   * Must be prefixed with NEXT_PUBLIC_.
   */
  client: {
    NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1).optional(),
    NEXT_PUBLIC_APP_URL: z
      .string()
      .url()
      .default("http://localhost:3000"),
  },

  /**
   * Destructure all variables from process.env.
   * Required by t3-env to access Next.js env vars.
   */
  runtimeEnv: {
    DATABASE_URL: process.env["DATABASE_URL"],
    SUPABASE_SERVICE_ROLE_KEY: process.env["SUPABASE_SERVICE_ROLE_KEY"],
    TELEGRAM_BOT_TOKEN: process.env["TELEGRAM_BOT_TOKEN"],
    TELEGRAM_WEBHOOK_SECRET: process.env["TELEGRAM_WEBHOOK_SECRET"],
    ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"],
    TAVILY_API_KEY: process.env["TAVILY_API_KEY"],
    NODE_ENV: process.env["NODE_ENV"],
    NEXT_PUBLIC_SUPABASE_URL: process.env["NEXT_PUBLIC_SUPABASE_URL"],
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env["NEXT_PUBLIC_SUPABASE_ANON_KEY"],
    NEXT_PUBLIC_APP_URL: process.env["NEXT_PUBLIC_APP_URL"],
  },

  /**
   * Skip validation when running in CI without real env vars.
   * Controlled by SKIP_ENV_VALIDATION=true.
   */
  skipValidation: !!process.env["SKIP_ENV_VALIDATION"],

  /**
   * Treat empty strings as undefined — avoids silent failures.
   */
  emptyStringAsUndefined: true,
});
