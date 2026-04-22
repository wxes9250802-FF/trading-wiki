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
 * One row per (symbol, alert_date, alert_type) — prevents duplicate pushes
 * for the same condition on the same trading day.
 *
 * alert_type values: "price_up" | "price_down" | "volume_spike"
 */
export const intradayAlertLog = pgTable(
  "intraday_alert_log",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

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
  (t) => [unique("intraday_alert_log_symbol_date_type_unique").on(t.symbol, t.alertDate, t.alertType)]
);

export type IntradayAlert = typeof intradayAlertLog.$inferSelect;
export type NewIntradayAlert = typeof intradayAlertLog.$inferInsert;
