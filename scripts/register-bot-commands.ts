#!/usr/bin/env bun
/**
 * Register the bot's slash-command menu via Telegram setMyCommands API.
 *
 * After running this, typing "/" in a chat with the bot surfaces an
 * autocomplete list with a one-line Chinese description per command.
 *
 * Run whenever the command list changes:
 *   bun run telegram:register-commands
 *
 * Required env vars:
 *   TELEGRAM_BOT_TOKEN — from @BotFather
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BOT_TOKEN = process.env["TELEGRAM_BOT_TOKEN"];
if (!BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN in .env.local or shell env.");
  process.exit(1);
}

// Each command is limited to:
//   command:     1-32 chars, [a-z0-9_]
//   description: 1-256 chars
const COMMANDS: { command: string; description: string }[] = [
  { command: "q", description: "查股票：即時價、三大法人、情報" },
  { command: "stats", description: "近 30 天情報總覽與熱門個股" },
  { command: "portfolio", description: "查看我的持股與損益" },
  { command: "buy", description: "買入：/buy 代號 張數 成本" },
  { command: "sell", description: "賣出（無參數進互動選單）" },
  { command: "clear", description: "一鍵清倉（全持股用現價賣出）" },
  { command: "import", description: "批次匯入持股（文字或截圖）" },
  { command: "alert", description: "設定盤中警示：/alert 代號 +N -N" },
  { command: "alerts", description: "列出已設定的警示" },
  { command: "unalert", description: "移除某檔警示：/unalert 代號" },
  { command: "invite", description: "產生邀請連結（管理員）" },
  { command: "help", description: "顯示完整指令說明" },
];

// Validate locally to catch typos before hitting the API
for (const c of COMMANDS) {
  if (!/^[a-z0-9_]{1,32}$/.test(c.command)) {
    console.error(`Invalid command name: "${c.command}"`);
    process.exit(1);
  }
  if (c.description.length < 1 || c.description.length > 256) {
    console.error(`Invalid description length for "${c.command}"`);
    process.exit(1);
  }
}

console.log(`Registering ${COMMANDS.length} commands:`);
for (const c of COMMANDS) console.log(`  /${c.command.padEnd(12)} ${c.description}`);

const res = await fetch(
  `https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      commands: COMMANDS,
      // scope default = "default" (applies to private + group chats for every user)
      language_code: "zh",
    }),
  }
);

const data = (await res.json()) as {
  ok: boolean;
  description?: string;
  error_code?: number;
};

if (!data.ok) {
  console.error(`\n✗ setMyCommands failed (${data.error_code}): ${data.description}`);
  process.exit(1);
}

console.log("\n✓ zh commands registered");

// Also set the default (language-agnostic) list as a fallback
const fallbackRes = await fetch(
  `https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ commands: COMMANDS }),
  }
);
const fallbackData = (await fallbackRes.json()) as { ok: boolean; description?: string };
if (!fallbackData.ok) {
  console.warn(`⚠ default-scope update failed: ${fallbackData.description}`);
} else {
  console.log("✓ default commands registered");
}

console.log("\n在 Telegram 輸入 / 就會看到指令清單（可能要等 1–2 分鐘、或重開聊天室）。");
