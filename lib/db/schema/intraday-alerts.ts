import {
  pgTable,
  uuid,
  text,
  date,
  numeric,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── Intraday Alert Log ───────────────────────────────────────────────────────

/**
 * Deduplication log for T6 intraday price/volume alerts.
 * One row per (user_id, symbol, alert_date, alert_type) — prevents duplicate
 * pushes for the same condition on the same trading day for the same user.
 *
 * alert_type values: "price_up" | "price_down" | "volume_spike"
 *
 * user_id was added when alerts became per-user (/alert command); different
 * users with different thresholds on the same symbol each get their own
 * dedup window.
 */
export const intradayAlertLog = pgTable(
  "intraday_alert_log",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    userId: uuid("user_id").notNull(),

    symbol: text("symbol").notNull(),

    alertDate: date("alert_date").notNull(),

    /** "price_up" | "price_down" | "volume_spike" */
    alertType: text("alert_type").notNull(),

    /** %-change (price alerts) or volume multiplier (volume_spike) */
    metric: numeric("metric", { precision: 10, scale: 2 }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    unique("intraday_alert_log_user_symbol_date_type_unique").on(
      t.userId,
      t.symbol,
      t.alertDate,
      t.alertType
    ),
  ]
);

export type IntradayAlert = typeof intradayAlertLog.$inferSelect;
export type NewIntradayAlert = typeof intradayAlertLog.$inferInsert;
