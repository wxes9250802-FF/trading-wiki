import {
  pgTable,
  uuid,
  text,
  numeric,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { userProfiles } from "./users";

// ─── Holdings ─────────────────────────────────────────────────────────────────

/**
 * Aggregated per (user, symbol) — one row per position.
 *
 * shares_lots is in 張 (lots); 1 張 = 1000 股.
 * avg_cost is per-share cost in TWD.
 * Updated on each /buy or /sell.
 */
export const holdings = pgTable("holdings", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),

  userId: uuid("user_id")
    .notNull()
    .references(() => userProfiles.id, { onDelete: "cascade" }),

  symbol: text("symbol").notNull(), // e.g. "2330.TW", "6451.TWO"

  sharesLots: numeric("shares_lots", { precision: 14, scale: 4 }).notNull().default("0"),

  avgCost: numeric("avg_cost", { precision: 14, scale: 4 }).notNull(),

  createdAt: timestamp("created_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),

  updatedAt: timestamp("updated_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
});

// ─── Holding Transactions ─────────────────────────────────────────────────────

/**
 * Audit log — one row per /buy or /sell command.
 * Never mutated; append-only.
 */
export const holdingTransactions = pgTable("holding_transactions", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),

  userId: uuid("user_id")
    .notNull()
    .references(() => userProfiles.id, { onDelete: "cascade" }),

  symbol: text("symbol").notNull(),

  action: text("action").notNull(), // 'buy' | 'sell'

  sharesLots: numeric("shares_lots", { precision: 14, scale: 4 }).notNull(),

  price: numeric("price", { precision: 14, scale: 4 }).notNull(),

  executedAt: timestamp("executed_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),

  note: text("note"),
});

// ─── Types ────────────────────────────────────────────────────────────────────

export type Holding = typeof holdings.$inferSelect;
export type NewHolding = typeof holdings.$inferInsert;
export type HoldingTransaction = typeof holdingTransactions.$inferSelect;
export type NewHoldingTransaction = typeof holdingTransactions.$inferInsert;
