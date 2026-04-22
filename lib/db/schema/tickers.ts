import {
  pgTable,
  uuid,
  text,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── Enum ─────────────────────────────────────────────────────────────────────

export const exchangeEnum = pgEnum("exchange", [
  "TWSE",
  "TPEx",
  "NYSE",
  "NASDAQ",
  "CRYPTO",
  "OTHER",
]);

// ─── Tickers ──────────────────────────────────────────────────────────────────

/**
 * Whitelist of valid trading symbols synced by T4 GitHub Actions cron.
 *
 * RLS:
 *   - ANON / authenticated: SELECT (ticker resolver + web UI)
 *   - service_role: full access (sync worker)
 */
export const tickers = pgTable("tickers", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),

  // Canonical symbol — e.g. "2330.TW", "AAPL", "BTC"
  symbol: text("symbol").notNull().unique(),

  name: text("name").notNull(), // Display name e.g. "台積電", "Apple Inc."

  exchange: exchangeEnum("exchange").notNull(),

  // Human-readable aliases stored as comma-separated text (simple, no pg arrays needed)
  // e.g. "台積電,護國神山,TSMC"
  aliases: text("aliases"),

  lastUpdated: timestamp("last_updated", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),

  // Set when ticker is delisted; never hard-delete
  delistedAt: timestamp("delisted_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
});

export type Ticker = typeof tickers.$inferSelect;
export type NewTicker = typeof tickers.$inferInsert;
