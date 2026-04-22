import {
  pgTable,
  uuid,
  bigint,
  text,
  numeric,
  boolean,
  timestamp,
  pgEnum,
  integer,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── Enums ───────────────────────────────────────────────────────────────────

export const marketEnum = pgEnum("market", ["TW", "US", "CRYPTO"]);
export const sentimentEnum = pgEnum("sentiment", [
  "bullish",
  "bearish",
  "neutral",
]);

// ─── Tips ─────────────────────────────────────────────────────────────────────

/**
 * Core table: one row per trading tip forwarded to the Telegram bot.
 *
 * Flow:
 *   1. User forwards message → T5 bot handler writes a row with raw_text only.
 *   2. T6 AI classifier fills in ticker / market / sentiment / summary /
 *      target_price / confidence and sets ai_classified = true.
 *   3. T11 verification engine creates tip_verifications rows at 7/14/30 days.
 *
 * RLS:
 *   - ANON key  → SELECT only (web dashboard reads)
 *   - service_role → full access (bot writes, GH Actions workers)
 */
export const tips = pgTable("tips", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),

  // Telegram context
  telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull(),
  telegramChatId: bigint("telegram_chat_id", { mode: "number" }).notNull(),
  telegramMessageId: bigint("telegram_message_id", {
    mode: "number",
  }).notNull(),

  // Raw content
  rawText: text("raw_text").notNull(),

  // AI-extracted fields (nullable until T6 runs)
  ticker: text("ticker"),
  market: marketEnum("market"),
  sentiment: sentimentEnum("sentiment"),
  summary: text("summary"),
  targetPrice: numeric("target_price", { precision: 14, scale: 4 }),
  confidence: integer("confidence"), // 0–100

  // Source tracking (user-supplied label, e.g. "LINE 群 A")
  sourceLabel: text("source_label"),

  // State flags
  aiClassified: boolean("ai_classified").default(false).notNull(),

  // Timestamps
  createdAt: timestamp("created_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
});

export type Tip = typeof tips.$inferSelect;
export type NewTip = typeof tips.$inferInsert;
