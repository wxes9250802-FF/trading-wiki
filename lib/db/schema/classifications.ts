import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  json,
  numeric,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { rawMessages } from "./raw-messages";
import { tips, sentimentEnum } from "./tips";

// ─── AI Classifications ───────────────────────────────────────────────────────

/**
 * Immutable log of every LLM classification call made by T6 worker.
 * Used for cost tracking, debugging, and fine-tuning data.
 *
 * RLS:
 *   - service_role only (workers write; T12 admin dashboard reads via service_role)
 */
export const aiClassifications = pgTable("ai_classifications", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),

  rawMessageId: uuid("raw_message_id")
    .notNull()
    .references(() => rawMessages.id, { onDelete: "cascade" }),

  // Null if classification failed before tip was created
  tipId: uuid("tip_id").references(() => tips.id, { onDelete: "set null" }),

  model: text("model").notNull(), // e.g. "claude-3-5-haiku-20241022"

  promptVersion: text("prompt_version").notNull(), // e.g. "classify-v1"

  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),

  // Full LLM JSON response, stored for debugging / fine-tuning
  rawResponse: json("raw_response"),

  // null = not yet shown; true/false = user feedback via bot inline buttons
  userConfirmed: boolean("user_confirmed"),

  // Populated when Zod validation or LLM call fails
  error: text("error"),

  createdAt: timestamp("created_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
});

// ─── Tip Tickers (many-to-many) ───────────────────────────────────────────────

/**
 * One tip can mention multiple tickers, each with its own sentiment & target price.
 *
 * RLS:
 *   - ANON / authenticated: SELECT
 *   - service_role: full access
 */
export const tipTickers = pgTable("tip_tickers", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),

  tipId: uuid("tip_id")
    .notNull()
    .references(() => tips.id, { onDelete: "cascade" }),

  // Store symbol directly — avoids FK join overhead in hot query paths
  symbol: text("symbol").notNull(),

  sentiment: sentimentEnum("sentiment").notNull(),

  targetPrice: numeric("target_price", { precision: 14, scale: 4 }),

  createdAt: timestamp("created_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
});

export type AiClassification = typeof aiClassifications.$inferSelect;
export type NewAiClassification = typeof aiClassifications.$inferInsert;
export type TipTicker = typeof tipTickers.$inferSelect;
export type NewTipTicker = typeof tipTickers.$inferInsert;
