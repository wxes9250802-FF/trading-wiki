import {
  pgTable,
  uuid,
  text,
  numeric,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { userProfiles } from "./users";

// ─── Pending Sells ────────────────────────────────────────────────────────────

/**
 * Short-lived state for the interactive `/sell` flow.
 *
 * One row per user (userId is the PK) — only one pending sell at a time.
 * Stores the symbol the user picked and the reference price (FinMind snapshot
 * at selection time). TTL is enforced in application logic (5 minutes).
 *
 * Flow:
 *   1. User runs /sell with no args → bot lists holdings.
 *   2. User taps a holding button → bot fetches current price, upserts a row
 *      here, and shows [全賣] [一半] buttons + invites a numeric reply.
 *   3. User taps [全賣] / [一半] or replies with a bare number → row is read,
 *      sell is executed at the stored price, row is deleted.
 *   4. TTL expiry (5 min) — row is stale; next /sell replaces it.
 */
export const pendingSells = pgTable("pending_sells", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => userProfiles.id, { onDelete: "cascade" }),

  symbol: text("symbol").notNull(),

  /** Reference price captured at selection time (FinMind snapshot). */
  price: numeric("price", { precision: 14, scale: 4 }).notNull(),

  createdAt: timestamp("created_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
});

export type PendingSell = typeof pendingSells.$inferSelect;
export type NewPendingSell = typeof pendingSells.$inferInsert;
