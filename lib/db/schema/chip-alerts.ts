import {
  pgTable,
  uuid,
  text,
  date,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── Chip Alert Log ───────────────────────────────────────────────────────────

/**
 * Deduplication log for T5 chip anomaly alerts.
 * One row per (symbol, alert_date) — prevents duplicate pushes on the same day.
 *
 * alert_types stores which anomaly types were detected, e.g. ["watch", "institutional"].
 */
export const chipAlertLog = pgTable(
  "chip_alert_log",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),

    symbol: text("symbol").notNull(),

    alertDate: date("alert_date").notNull(),

    /** Array of detected alert types, e.g. ["watch", "institutional"] */
    alertTypes: text("alert_types").array().notNull(),

    createdAt: timestamp("created_at", { withTimezone: true })
      .default(sql`now()`)
      .notNull(),
  },
  (table) => [unique("chip_alert_log_symbol_date_unique").on(table.symbol, table.alertDate)]
);

export type ChipAlertLog = typeof chipAlertLog.$inferSelect;
export type NewChipAlertLog = typeof chipAlertLog.$inferInsert;
