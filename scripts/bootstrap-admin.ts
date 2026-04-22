#!/usr/bin/env bun
/**
 * Bootstrap Admin — one-time setup script
 *
 * Creates the first admin user profile so they can use bot commands
 * (/invite, /mystats) without going through the invite-code flow.
 *
 * Required env vars:
 *   TELEGRAM_USER_ID  — The admin's Telegram numeric user ID
 *                       (send /start to @userinfobot to find yours)
 *
 * Optional env vars:
 *   ADMIN_UUID        — Supabase auth UUID to use as the profile ID.
 *                       If omitted, a random UUID is generated.
 *                       Set this if you want to link a Supabase auth account.
 *
 * Usage:
 *   TELEGRAM_USER_ID=123456789 bun run bootstrap:admin
 *
 * Or with a Supabase auth UUID:
 *   TELEGRAM_USER_ID=123456789 ADMIN_UUID=<uuid> bun run bootstrap:admin
 *
 * Notes:
 *   - Idempotent: re-running with the same TELEGRAM_USER_ID updates the role
 *     if a profile already exists with a different role.
 *   - If ADMIN_UUID is not provided, the user cannot log in via the web UI
 *     (no matching Supabase auth user). For a Telegram-only admin, this is fine.
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { userProfiles } from "@/lib/db/schema/users";

// ─── Validate inputs ──────────────────────────────────────────────────────────

const DATABASE_URL = process.env["DATABASE_URL"];
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not set");
  process.exit(1);
}

const telegramIdRaw = process.env["TELEGRAM_USER_ID"];
if (!telegramIdRaw) {
  console.error("ERROR: TELEGRAM_USER_ID is not set");
  console.error("  Get your Telegram user ID by sending /start to @userinfobot");
  process.exit(1);
}

const telegramId = parseInt(telegramIdRaw, 10);
if (!Number.isInteger(telegramId) || telegramId <= 0) {
  console.error(`ERROR: TELEGRAM_USER_ID must be a positive integer, got: ${telegramIdRaw}`);
  process.exit(1);
}

const adminId = process.env["ADMIN_UUID"] ?? crypto.randomUUID();

// ─── DB setup ─────────────────────────────────────────────────────────────────

const pg = postgres(DATABASE_URL, { max: 1, prepare: false });
const db = drizzle(pg);

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function bootstrap() {
  console.log("═══ Bootstrap Admin ═══");
  console.log(`  Telegram user ID : ${telegramId}`);
  console.log(`  Profile UUID     : ${adminId}`);

  // Check for an existing profile with this telegramId
  const [existing] = await db
    .select({ id: userProfiles.id, role: userProfiles.role })
    .from(userProfiles)
    .where(eq(userProfiles.telegramId, telegramId))
    .limit(1);

  if (existing) {
    if (existing.role === "admin") {
      console.log(`\n✅ Profile already exists with role=admin (id=${existing.id})`);
      console.log("   Nothing to do.");
      await pg.end();
      return;
    }

    // Upgrade existing profile to admin
    await db
      .update(userProfiles)
      .set({ role: "admin" })
      .where(eq(userProfiles.id, existing.id));

    console.log(`\n✅ Upgraded existing profile to admin (id=${existing.id})`);
  } else {
    // Create new admin profile
    await db.insert(userProfiles).values({
      id: adminId,
      telegramId,
      role: "admin",
    });

    console.log(`\n✅ Admin profile created (id=${adminId})`);
  }

  console.log("\nNext steps:");
  console.log("  1. Make sure the Telegram webhook is registered:");
  console.log("     bun run telegram:register");
  console.log("  2. Send /help to your bot to verify admin access.");
  console.log("  3. Use /invite to generate invite codes for other users.");
  await pg.end();
}

bootstrap().catch((err) => {
  console.error("Bootstrap failed:", err);
  process.exit(1);
});
