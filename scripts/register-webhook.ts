#!/usr/bin/env bun
/**
 * T5 — Telegram Webhook Registration
 *
 * One-time script: registers your Vercel deployment URL as the Telegram
 * webhook and sets the secret token for request authentication.
 *
 * Run AFTER deploying to Vercel:
 *   bun run telegram:register
 *
 * Or with a custom app URL (e.g. Vercel preview):
 *   NEXT_PUBLIC_APP_URL=https://trading-wiki-git-main.vercel.app bun run telegram:register
 *
 * Required env vars (in .env.local or shell):
 *   TELEGRAM_BOT_TOKEN       — from @BotFather
 *   TELEGRAM_WEBHOOK_SECRET  — any random string (min 1 char, max 256 chars)
 *   NEXT_PUBLIC_APP_URL      — your production Vercel URL
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import type { TelegramApiResponse } from "@/lib/telegram/types";

// ─── Validate env ─────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env["TELEGRAM_BOT_TOKEN"];
const WEBHOOK_SECRET = process.env["TELEGRAM_WEBHOOK_SECRET"];
const APP_URL = process.env["NEXT_PUBLIC_APP_URL"];

const missing: string[] = [];
if (!BOT_TOKEN) missing.push("TELEGRAM_BOT_TOKEN");
if (!WEBHOOK_SECRET) missing.push("TELEGRAM_WEBHOOK_SECRET");
if (!APP_URL || APP_URL === "http://localhost:3000") {
  missing.push("NEXT_PUBLIC_APP_URL (must be your production/preview Vercel URL)");
}

if (missing.length > 0) {
  console.error("Missing required env vars:");
  missing.forEach((v) => console.error(`  • ${v}`));
  console.error("\nAdd them to .env.local or export them in your shell, then re-run.");
  process.exit(1);
}

// ─── Register ─────────────────────────────────────────────────────────────────

const webhookUrl = `${APP_URL}/api/telegram/webhook`;

console.log(`Registering webhook: ${webhookUrl}`);

const res = await fetch(
  `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: webhookUrl,
      secret_token: WEBHOOK_SECRET,
      // Only ask Telegram to deliver these update types to keep traffic lean
      allowed_updates: ["message", "callback_query"],
      // Drop pending updates older than 30 s on (re-)registration to avoid
      // replaying a backlog of stale messages on the first deploy
      drop_pending_updates: true,
    }),
  }
);

const data = (await res.json()) as TelegramApiResponse;

if (data.ok) {
  console.log("✓ Webhook registered successfully");
  console.log(`  URL:    ${webhookUrl}`);
  console.log(`  Secret: ${WEBHOOK_SECRET!.slice(0, 4)}${"*".repeat(Math.max(0, WEBHOOK_SECRET!.length - 4))}`);
} else {
  console.error(`✗ Registration failed (${data.error_code}): ${data.description}`);
  process.exit(1);
}

// ─── Verify ───────────────────────────────────────────────────────────────────

const infoRes = await fetch(
  `https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`
);
const info = (await infoRes.json()) as TelegramApiResponse<{
  url: string;
  has_custom_certificate: boolean;
  pending_update_count: number;
  last_error_message?: string;
  last_error_date?: number;
}>;

if (info.ok && info.result) {
  const r = info.result;
  console.log("\nWebhook info:");
  console.log(`  url:                   ${r.url}`);
  console.log(`  pending_update_count:  ${r.pending_update_count}`);
  if (r.last_error_message) {
    console.warn(`  last_error:            ${r.last_error_message}`);
  }
}
