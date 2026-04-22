import {
  pgTable,
  uuid,
  bigint,
  text,
  boolean,
  timestamp,
  pgEnum,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── Enums ───────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum("user_role", ["admin", "member"]);

// ─── User Profiles ────────────────────────────────────────────────────────────

/**
 * One row per registered user — extends Supabase Auth (auth.users).
 * The FK to auth.users(id) is enforced via raw SQL in the migration file,
 * not here, because Drizzle cannot reference tables outside the public schema.
 *
 * RLS:
 *   - Authenticated users: SELECT own row (auth.uid() = id)
 *   - service_role: full access
 */
export const userProfiles = pgTable("user_profiles", {
  // Same UUID as auth.users.id — linked via FK in migration SQL
  id: uuid("id").primaryKey(),

  telegramId: bigint("telegram_id", { mode: "number" }),

  displayName: text("display_name"),

  role: userRoleEnum("role").default("member").notNull(),

  // Allowlist level controls bot access (checked per-message in T5)
  allowlistLevel: userRoleEnum("allowlist_level").default("member").notNull(),

  invitedBy: uuid("invited_by"), // self-ref FK added via raw SQL in migration

  createdAt: timestamp("created_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
});

// ─── Invite Codes ─────────────────────────────────────────────────────────────

/**
 * Single-use, time-limited invite codes.
 * Admin generates via T12 UI; recipient uses at /auth/signup.
 *
 * RLS: service_role only.
 */
export const inviteCodes = pgTable("invite_codes", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),

  code: text("code").notNull().unique(), // 12-char crypto random

  createdBy: uuid("created_by").notNull(), // user_profiles.id

  usedBy: uuid("used_by"), // user_profiles.id, set on redemption

  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),

  usedAt: timestamp("used_at", { withTimezone: true }),

  isRevoked: boolean("is_revoked").default(false).notNull(),

  createdAt: timestamp("created_at", { withTimezone: true })
    .default(sql`now()`)
    .notNull(),
});

export type UserProfile = typeof userProfiles.$inferSelect;
export type NewUserProfile = typeof userProfiles.$inferInsert;
export type InviteCode = typeof inviteCodes.$inferSelect;
export type NewInviteCode = typeof inviteCodes.$inferInsert;
