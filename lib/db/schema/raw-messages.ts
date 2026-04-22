import {
  pgTable,
  uuid,
  bigint,
  text,
  boolean,
  timestamp,
  pgEnum,
  integer,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── Enum ─────────────────────────────────────────────────────────────────────

export const rawMessageStatusEnum = pgEnum("raw_message_status", [
  "pending",   // waiting for T6 AI worker
  "processing",// worker picked it up
  "done",      // tip created successfully
  "failed",    // AI classification failed after retries (DLQ)
  "ignored",   // not a trading tip (general chat)
]);

// ─── Raw Messages ─────────────────────────────────────────────────────────────

/**
 * Every Telegram message received by the bot, before AI processing.
 * Acts as the job queue for T6 AI classification worker.
 *
 * The unique constraint on telegram_update_id provides idempotency:
 * duplicate webhook deliveries from Telegram are silently ignored.
 *
 * RLS:
 *   - service_role only (bot writes, GH Actions worker reads/updates)
 *   - ANON has no access
 */
export const rawMessages = pgTable("raw_messages", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),

  // Telegram dedup key — unique across the whole table
  telegramUpdateId: bigint("telegram_update_id", { mode: "number" })
    .notNull()
    .unique(),

  telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull(),
  telegramChatId: bigint("telegram_chat_id", { mode: "number" }).notNull(),
  telegramMessageId: bigint("telegram_message_id", {
    mode: "number",
  }).notNull(),

  messageText: text("message_text").notNull(),

  messageDate: timestamp("message_date", { withTimezone: true }).notNull(),

  status: rawMessageStatusEnum("status").default("pending").notNull(),

  // True if message was >2000 chars and truncated before storage
  truncated: boolean("truncated").default(false).notNull(),

  // Set by T6 worker on successful classification
  aiTipId: uuid("ai_tip_id"),

  // Retry counter for T6 worker
  retryCount: integer("retry_count").default(0).notNull(),

  createdAt: timestamp("created_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
});

export type RawMessage = typeof rawMessages.$inferSelect;
export type NewRawMessage = typeof rawMessages.$inferInsert;
