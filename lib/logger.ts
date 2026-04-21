import pino from "pino";
import { env } from "@/lib/env";

const isDev = env.NODE_ENV !== "production";

/**
 * Application logger built on pino.
 *
 * In development:  pretty-prints with pino-pretty (human-readable, coloured).
 *                   Uses a worker thread via pino.transport; next.config.mjs has
 *                   serverExternalPackages configured so the Next bundler does
 *                   not try to inline pino/pino-pretty/thread-stream.
 *
 * In production:   outputs newline-delimited JSON to stdout for log aggregators
 *                   (Vercel logs, Supabase logs, etc). No worker thread.
 *
 * Edge runtime caveat: pino is Node-only. Do NOT import this logger from
 * Edge runtime routes (e.g. the Telegram webhook in T5). For Edge routes,
 * fall back to console.{log,error} or use a dedicated Edge-compatible logger.
 *
 * Usage:
 *   import { logger } from "@/lib/logger";
 *   logger.info({ userId: "abc" }, "User logged in");
 *   logger.error({ err }, "Unhandled error");
 */
export const logger = pino(
  {
    level: isDev ? "debug" : "info",
    // Redact sensitive fields from log output.
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "*.password",
        "*.token",
        "*.apiKey",
        "*.secret",
      ],
      censor: "[REDACTED]",
    },
  },
  isDev
    ? pino.transport({
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss",
          ignore: "pid,hostname",
        },
      })
    : undefined
);
