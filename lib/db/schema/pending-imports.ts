import {
  pgTable,
  uuid,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { userProfiles } from "./users";

// ─── Pending Imports ──────────────────────────────────────────────────────────

/**
 * Temporary holding area for photo-parsed holdings awaiting user confirmation.
 * Each row expires after 30 minutes (enforced in application logic, not DB).
 *
 * Flow:
 *   1. User sends photo with /import caption.
 *   2. Claude Vision parses the image → row inserted here.
 *   3. Bot sends message with inline keyboard (✅ 確認 / ❌ 取消).
 *   4. On confirm → write to holdings; on cancel → delete row.
 */
export const pendingImports = pgTable("pending_imports", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),

  userId: uuid("user_id")
    .notNull()
    .references(() => userProfiles.id, { onDelete: "cascade" }),

  /** JSON array of { symbol, sharesLots, avgCost } */
  payload: jsonb("payload").notNull(),

  createdAt: timestamp("created_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
});

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PendingImportItem {
  symbol: string;
  sharesLots: number;
  avgCost: number;
}

export type PendingImport = typeof pendingImports.$inferSelect;
export type NewPendingImport = typeof pendingImports.$inferInsert;
