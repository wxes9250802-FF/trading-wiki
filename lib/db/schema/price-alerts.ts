import {
  pgTable,
  uuid,
  text,
  numeric,
  boolean,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Per-user, per-stock price alert thresholds.
 *
 * Any of up_pct / down_pct / volume_multiplier can be NULL — means "no alert
 * for that axis". At least one must be set for the row to be meaningful,
 * enforced at the application layer.
 *
 * Conventions:
 *   up_pct:            positive number (e.g. 3 means +3%)
 *   down_pct:          stored as NEGATIVE number (e.g. -5 means fire when change <= -5%)
 *   volume_multiplier: positive >= 1 (e.g. 2.5 means today volume >= 20d avg × 2.5)
 *
 * Only rows where enabled = true are considered by the intraday alert worker.
 */
export const priceAlerts = pgTable(
  "price_alerts",
  {
    id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),

    userId: uuid("user_id").notNull(),

    symbol: text("symbol").notNull(),

    upPct: numeric("up_pct", { precision: 6, scale: 2 }),
    downPct: numeric("down_pct", { precision: 6, scale: 2 }),
    volumeMultiplier: numeric("volume_multiplier", { precision: 6, scale: 2 }),

    enabled: boolean("enabled").notNull().default(true),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    userSymbolUniq: unique().on(t.userId, t.symbol),
  })
);

export type PriceAlert = typeof priceAlerts.$inferSelect;
export type NewPriceAlert = typeof priceAlerts.$inferInsert;
