import {
  pgTable,
  uuid,
  integer,
  numeric,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tips } from "./tips";

// ─── Enum ─────────────────────────────────────────────────────────────────────

export const verificationResultEnum = pgEnum("verification_result", [
  "pending",
  "hit",
  "miss",
]);

// ─── Tip Verifications ────────────────────────────────────────────────────────

/**
 * Price-outcome records created by the T11 verification cron job.
 *
 * One tip gets up to 3 rows: check_days ∈ {7, 14, 30}.
 * The cron runs daily and flips result from 'pending' → 'hit'|'miss'
 * once the required days have elapsed.
 *
 * Hit criteria (from CEO plan):
 *   TW / US stocks : price moved ≥ 3 % in the sentiment direction
 *   Crypto         : price moved ≥ 10 % in the sentiment direction
 *
 * RLS: same as tips (ANON read, service_role write).
 */
export const tipVerifications = pgTable("tip_verifications", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),

  tipId: uuid("tip_id")
    .notNull()
    .references(() => tips.id, { onDelete: "cascade" }),

  checkDays: integer("check_days").notNull(), // 7 | 14 | 30

  // Prices captured at tip creation and at check time
  priceAtTip: numeric("price_at_tip", { precision: 14, scale: 4 }),
  priceAtCheck: numeric("price_at_check", { precision: 14, scale: 4 }),

  result: verificationResultEnum("result").default("pending").notNull(),

  checkedAt: timestamp("checked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
});

export type TipVerification = typeof tipVerifications.$inferSelect;
export type NewTipVerification = typeof tipVerifications.$inferInsert;
