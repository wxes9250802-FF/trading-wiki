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
 * Price-target monitoring records created by the classification worker.
 *
 * One row is created per tip that has a target_price mentioned in the original
 * message. The daily cron (verify-tips.ts) checks whether the current price
 * has reached the target and notifies the user when it does.
 *
 * Hit criteria:
 *   bullish tip → current price >= target_price
 *   bearish tip → current price <= target_price
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

  // Legacy field — set to 0 for target-price monitoring rows
  checkDays: integer("check_days").default(0),

  // Price at the time the tip was classified
  priceAtTip: numeric("price_at_tip", { precision: 14, scale: 4 }),

  // Price at the time the target was hit
  priceAtCheck: numeric("price_at_check", { precision: 14, scale: 4 }),

  // The target price mentioned in the original tip.
  // Monitoring only happens when this is set.
  targetPrice: numeric("target_price", { precision: 14, scale: 4 }),

  result: verificationResultEnum("result").default("pending").notNull(),

  checkedAt: timestamp("checked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
});

export type TipVerification = typeof tipVerifications.$inferSelect;
export type NewTipVerification = typeof tipVerifications.$inferInsert;
