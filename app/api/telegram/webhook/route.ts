/**
 * T5 + T8 + T14 — Telegram Webhook Receiver
 *
 * Handles three types of Telegram updates:
 *
 * 1. `message`        (T5)  — stores raw message for T6 AI worker
 * 2. `callback_query` (T8)  — user tapped ✅/❌ on a tip classification
 * 3. bot commands     (T14) — /start /help /invite /mystats
 *
 * Security: always return HTTP 200. Returning 4xx/5xx causes Telegram to retry
 * for up to 3 days, creating noise. Auth failures are silently ignored.
 */
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { userProfiles, inviteCodes } from "@/lib/db/schema/users";
import { rawMessages } from "@/lib/db/schema/raw-messages";
import { aiClassifications } from "@/lib/db/schema/classifications";
import { tips } from "@/lib/db/schema/tips";
import {
  answerCallbackQuery,
  editMessageReplyMarkup,
  sendMessage,
} from "@/lib/telegram/client";
import type { TelegramUpdate, TelegramCallbackQuery } from "@/lib/telegram/types";

const MAX_TEXT_CHARS = 2000;
const WEBHOOK_SECRET = process.env["TELEGRAM_WEBHOOK_SECRET"];

// ─── Main handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // Validate secret token
  const incomingSecret = req.headers.get("x-telegram-bot-api-secret-token");
  if (WEBHOOK_SECRET && incomingSecret !== WEBHOOK_SECRET) return ok();

  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return ok();
  }

  // Route to the correct handler
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return ok();
  }

  if (update.message) {
    await handleMessage(update);
    return ok();
  }

  return ok();
}

// ─── T5 + T14: store incoming message / handle commands ───────────────────────

async function handleMessage(update: TelegramUpdate): Promise<void> {
  const msg = update.message!;
  const rawText = msg.text ?? msg.caption;
  if (!rawText?.trim() || msg.from?.is_bot) return;

  const telegramUserId = msg.from?.id;
  if (!telegramUserId) return;

  // Allowlist check — also fetch role for command auth
  const [profile] = await db
    .select({ id: userProfiles.id, role: userProfiles.role })
    .from(userProfiles)
    .where(eq(userProfiles.telegramId, telegramUserId))
    .limit(1);
  if (!profile) return;

  const text = rawText.trim();

  // T14: intercept bot commands — do not persist to rawMessages
  if (text.startsWith("/")) {
    await handleCommand(text, profile, msg.chat.id, telegramUserId);
    return;
  }

  const truncated = text.length > MAX_TEXT_CHARS;
  const storedText = truncated ? text.slice(0, MAX_TEXT_CHARS) : text;

  try {
    await db
      .insert(rawMessages)
      .values({
        telegramUpdateId: update.update_id,
        telegramUserId,
        telegramChatId: msg.chat.id,
        telegramMessageId: msg.message_id,
        messageText: storedText,
        messageDate: new Date(msg.date * 1000),
        truncated,
        status: "pending",
      })
      .onConflictDoNothing();
  } catch (err) {
    console.error("[webhook] DB insert failed:", err);
  }
}

// ─── T14: command dispatcher ──────────────────────────────────────────────────

async function handleCommand(
  rawCommand: string,
  profile: { id: string; role: string },
  chatId: number,
  telegramUserId: number
): Promise<void> {
  // Only the first word is the command name (ignore @BotName suffix and args)
  const command = rawCommand.split(/\s+/)[0]!.toLowerCase().split("@")[0]!;

  try {
    if (command === "/start" || command === "/help") {
      await sendMessage({
        chat_id: chatId,
        text: [
          "🤖 <b>Trading Intelligence Hub</b>",
          "",
          "可用指令：",
          "/mystats — 查看我的情報統計",
          "/help — 顯示此說明",
          "",
          "（管理員限定）",
          "/invite — 產生新邀請碼",
        ].join("\n"),
        parse_mode: "HTML",
      });
      return;
    }

    if (command === "/invite") {
      if (profile.role !== "admin") {
        await sendMessage({
          chat_id: chatId,
          text: "⛔ 此指令僅限管理員使用。",
          parse_mode: "HTML",
        });
        return;
      }

      const code = await createInviteCode(profile.id);
      const appUrl =
        process.env["NEXT_PUBLIC_APP_URL"] ?? "http://localhost:3000";
      await sendMessage({
        chat_id: chatId,
        text: [
          "🎟 <b>邀請碼已產生</b>",
          "",
          `<b>邀請碼：</b><code>${code}</code>`,
          "<b>有效期限：</b>7 天",
          "",
          "<b>邀請連結：</b>",
          `${appUrl}/auth/signup?invite_code=${code}`,
          "",
          "請直接將連結傳給被邀請人。",
        ].join("\n"),
        parse_mode: "HTML",
      });
      return;
    }

    if (command === "/mystats") {
      const rows = await db
        .select({ market: tips.market, sentiment: tips.sentiment })
        .from(tips)
        .where(eq(tips.telegramUserId, telegramUserId));

      const total = rows.length;
      const tw = rows.filter((r) => r.market === "TW").length;
      const us = rows.filter((r) => r.market === "US").length;
      const crypto = rows.filter((r) => r.market === "CRYPTO").length;
      const bullish = rows.filter((r) => r.sentiment === "bullish").length;
      const bearish = rows.filter((r) => r.sentiment === "bearish").length;
      const neutral = rows.filter((r) => r.sentiment === "neutral").length;

      await sendMessage({
        chat_id: chatId,
        text: [
          "📊 <b>我的情報統計</b>",
          "",
          `<b>共 ${total} 筆情報</b>`,
          "",
          "<b>市場分佈：</b>",
          `🇹🇼 台股：${tw} 筆`,
          `🇺🇸 美股：${us} 筆`,
          `₿ 加密貨幣：${crypto} 筆`,
          "",
          "<b>方向分佈：</b>",
          `📈 看多：${bullish} 筆`,
          `📉 看空：${bearish} 筆`,
          `➡️ 中性：${neutral} 筆`,
        ].join("\n"),
        parse_mode: "HTML",
      });
      return;
    }

    // Unknown command
    await sendMessage({
      chat_id: chatId,
      text: "未知指令，輸入 /help 查看可用指令。",
      parse_mode: "HTML",
    });
  } catch (err) {
    console.error("[webhook] handleCommand error:", err);
    await sendMessage({
      chat_id: chatId,
      text: "⚠️ 指令執行失敗，請稍後再試。",
      parse_mode: "HTML",
    });
  }
}

// ─── T14: invite code generator ───────────────────────────────────────────────

async function createInviteCode(createdBy: string): Promise<string> {
  const CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const code = Array.from(bytes)
    .map((b) => CHARSET[b % 32]!)
    .join("");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const [row] = await db
    .insert(inviteCodes)
    .values({ code, createdBy, expiresAt })
    .returning({ code: inviteCodes.code });
  if (!row) throw new Error("Failed to create invite code");
  return row.code;
}

// ─── T8: handle ✅ / ❌ button tap ─────────────────────────────────────────────

async function handleCallbackQuery(query: TelegramCallbackQuery): Promise<void> {
  const data = query.data ?? "";

  // Expected format: "conf:{uuid}" or "rejt:{uuid}"
  const colonIdx = data.indexOf(":");
  const action = colonIdx > 0 ? data.slice(0, colonIdx) : "";
  const classificationId = colonIdx > 0 ? data.slice(colonIdx + 1) : "";

  if ((action !== "conf" && action !== "rejt") || !classificationId) {
    await answerCallbackQuery({ callback_query_id: query.id });
    return;
  }

  const confirmed = action === "conf";
  const senderId = query.from.id;

  // Fetch classification + verify ownership via raw_messages.telegram_user_id
  const [row] = await db
    .select({
      id: aiClassifications.id,
      userConfirmed: aiClassifications.userConfirmed,
      originalSenderId: rawMessages.telegramUserId,
    })
    .from(aiClassifications)
    .innerJoin(rawMessages, eq(aiClassifications.rawMessageId, rawMessages.id))
    .where(eq(aiClassifications.id, classificationId))
    .limit(1);

  if (!row) {
    await answerCallbackQuery({ callback_query_id: query.id, text: "找不到這筆情報" });
    return;
  }

  // Security: only the user who sent the original message can confirm/reject
  if (row.originalSenderId !== senderId) {
    await answerCallbackQuery({
      callback_query_id: query.id,
      text: "你沒有操作這筆情報的權限",
      show_alert: true,
    });
    return;
  }

  // Idempotency: already acted on
  if (row.userConfirmed !== null) {
    await answerCallbackQuery({
      callback_query_id: query.id,
      text: row.userConfirmed ? "已標記為確認 ✅" : "已標記為駁回 ❌",
    });
    return;
  }

  // Persist the decision
  await db
    .update(aiClassifications)
    .set({ userConfirmed: confirmed })
    .where(eq(aiClassifications.id, classificationId));

  // 1. Answer callback → removes spinner from button
  await answerCallbackQuery({
    callback_query_id: query.id,
    text: confirmed ? "✅ 已確認，情報記錄完成！" : "❌ 已駁回，已標記為不準確。",
  });

  // 2. Remove buttons from the original message (UX: prevent double-tap)
  if (query.message) {
    await editMessageReplyMarkup({
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      reply_markup: { inline_keyboard: [] },
    });
  }

  // 3. Send a brief follow-up so the user gets a push notification
  await sendMessage({
    chat_id: query.from.id,
    text: confirmed
      ? "✅ <b>情報已確認</b>，已記錄進資料庫。"
      : "❌ <b>情報已駁回</b>，AI 分類結果已標記為不準確。",
    parse_mode: "HTML",
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ok() {
  return new NextResponse(null, { status: 200 });
}
