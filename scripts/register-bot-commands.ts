#!/usr/bin/env bun
/**
 * Register the bot's slash-command menu via Telegram setMyCommands API.
 *
 * Two scopes:
 *   - default        : commands every user sees in the / menu
 *   - chat(admin_id) : commands admins see (adds /invite)
 *
 * Admin telegram IDs come from ADMIN_TELEGRAM_IDS env (comma-separated).
 *
 * Run whenever the command list changes:
 *   bun run telegram:register-commands
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const BOT_TOKEN = process.env["TELEGRAM_BOT_TOKEN"];
if (!BOT_TOKEN) {
  console.error("Missing TELEGRAM_BOT_TOKEN in .env.local or shell env.");
  process.exit(1);
}

const ADMIN_IDS = (process.env["ADMIN_TELEGRAM_IDS"] ?? "")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0);

if (ADMIN_IDS.length === 0) {
  console.warn("⚠ ADMIN_TELEGRAM_IDS not set — /invite won't appear in any menu.");
  console.warn("  Add ADMIN_TELEGRAM_IDS=<your_telegram_numeric_id> to .env.local");
}

// ─── Command definitions ──────────────────────────────────────────────────────

type Cmd = { command: string; description: string };

const MEMBER_COMMANDS: Cmd[] = [
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
  { command: "help", description: "顯示完整指令說明" },
];

const ADMIN_COMMANDS: Cmd[] = [
  ...MEMBER_COMMANDS,
  { command: "invite", description: "產生新邀請連結（管理員）" },
];

for (const c of ADMIN_COMMANDS) {
  if (!/^[a-z0-9_]{1,32}$/.test(c.command)) {
    console.error(`Invalid command name: ${c.command}`);
    process.exit(1);
  }
}

// ─── API ──────────────────────────────────────────────────────────────────────

async function setCommands(
  commands: Cmd[],
  scope?: { type: string; chat_id?: number }
): Promise<void> {
  const body: Record<string, unknown> = { commands };
  if (scope) body["scope"] = scope;

  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/setMyCommands`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  const data = (await res.json()) as {
    ok: boolean;
    description?: string;
    error_code?: number;
  };
  if (!data.ok) {
    throw new Error(
      `setMyCommands failed (${data.error_code}): ${data.description}`
    );
  }
}

/** Delete any commands scoped to a language — avoids stale zh-locale set
 *  from earlier versions of this script overriding our new default. */
async function deleteLanguageScopedCommands(language: string): Promise<void> {
  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/deleteMyCommands`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language_code: language }),
    }
  );
  const data = (await res.json()) as { ok: boolean };
  if (!data.ok) {
    console.warn(`⚠ deleteMyCommands language=${language} failed (non-fatal)`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Clean up any zh-locale commands set by older versions — without this,
  // Telegram's scope precedence picks the zh one over our new default for
  // zh users and the per-admin chat scope never kicks in.
  await deleteLanguageScopedCommands("zh");
  console.log("✓ cleared zh-locale commands");

  // Default scope — everyone sees these
  await setCommands(MEMBER_COMMANDS);
  console.log(`✓ default commands registered (${MEMBER_COMMANDS.length} entries)`);

  // Per-admin chat scope — adds /invite
  for (const id of ADMIN_IDS) {
    await setCommands(ADMIN_COMMANDS, { type: "chat", chat_id: id });
    console.log(`✓ admin commands registered for chat ${id} (${ADMIN_COMMANDS.length} entries)`);
  }

  console.log("\n在 Telegram 輸入 / 確認：");
  console.log("  • 你（admin）：看到 /invite");
  console.log("  • 其他成員：不會看到 /invite");
  console.log("（Telegram 端可能有 1-2 分鐘快取，換 chat 可加速）");
}

main().catch((err) => {
  console.error("✗", err);
  process.exit(1);
});
