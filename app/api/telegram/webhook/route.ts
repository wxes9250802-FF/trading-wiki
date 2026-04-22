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
import { eq, and, isNull, gt, inArray, desc } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { createSupabaseAdminClient } from "@/lib/auth/admin";
import { userProfiles, inviteCodes } from "@/lib/db/schema/users";
import { rawMessages } from "@/lib/db/schema/raw-messages";
import { aiClassifications, tipTickers } from "@/lib/db/schema/classifications";
import { tips } from "@/lib/db/schema/tips";
import {
  answerCallbackQuery,
  editMessageReplyMarkup,
  sendMessage,
} from "@/lib/telegram/client";
import type { TelegramUpdate, TelegramCallbackQuery, TelegramMessage } from "@/lib/telegram/types";

const MAX_TEXT_CHARS = 2000;
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── Content hash ─────────────────────────────────────────────────────────────

/**
 * Returns a 16-char hex hash of normalised text, or null for media placeholders.
 * Used for 24-hour deduplication across users.
 */
async function computeContentHash(text: string): Promise<string | null> {
  const PLACEHOLDERS = ["[截圖]", "[PDF 文件]"];
  if (PLACEHOLDERS.includes(text.trim())) return null;

  const normalised = text.trim().toLowerCase().replace(/\s+/g, " ");
  const encoded = new TextEncoder().encode(normalised);
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoded);
  const hex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hex.slice(0, 16);
}
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

  // Detect supported media (photo or PDF)
  const hasPhoto = !!(msg.photo?.length);
  const hasPdf = msg.document?.mime_type === "application/pdf";

  // Skip if no text AND no supported media (e.g. stickers, voice, video)
  if (!rawText?.trim() && !hasPhoto && !hasPdf) return;

  const text = (rawText ?? "").trim();

  // /start <code> — new user invite redemption, runs BEFORE allowlist check
  const startMatch = /^\/start(?:@\S+)?(?:\s+(\S+))?$/i.exec(text);
  if (startMatch !== null) {
    const code = startMatch[1]?.toUpperCase();
    if (code) {
      await handleInviteRedemption(code, telegramUserId, msg.chat.id);
      return;
    }
  }

  // Allowlist check — also fetch role for command auth
  const [profile] = await db
    .select({ id: userProfiles.id, role: userProfiles.role })
    .from(userProfiles)
    .where(eq(userProfiles.telegramId, telegramUserId))
    .limit(1);
  if (!profile) {
    await sendMessage({
      chat_id: msg.chat.id,
      text: "👋 你尚未加入白名單。\n\n請向管理員申請邀請連結，點擊連結即可自動加入。",
      parse_mode: "HTML",
    });
    return;
  }

  // T14: intercept bot commands — do not persist to rawMessages
  if (text.startsWith("/")) {
    await handleCommand(text, profile, msg.chat.id, telegramUserId);
    return;
  }

  const truncated = text.length > MAX_TEXT_CHARS;
  const storedText = truncated ? text.slice(0, MAX_TEXT_CHARS) : text;

  // Resolve media info: largest photo size, or PDF document
  const { mediaType, mediaFileId } = resolveMedia(msg);

  // Placeholder text for media-only messages (no caption)
  const finalText = storedText || (mediaType === "photo" ? "[截圖]" : "[PDF 文件]");

  // ── Dedup check: same text from a different user within 24h ──────────────
  const contentHash = await computeContentHash(finalText);
  if (contentHash) {
    const dedupCutoff = new Date(Date.now() - DEDUP_WINDOW_MS);
    const [cached] = await db
      .select({
        tipId: rawMessages.aiTipId,
        market: tips.market,
        sentiment: tips.sentiment,
        summary: tips.summary,
        confidence: tips.confidence,
        ticker: tips.ticker,
      })
      .from(rawMessages)
      .innerJoin(tips, eq(rawMessages.aiTipId, tips.id))
      .where(
        and(
          eq(rawMessages.contentHash, contentHash),
          eq(rawMessages.status, "done"),
          gt(rawMessages.createdAt, dedupCutoff)
        )
      )
      .limit(1);

    if (cached) {
      const MARKET: Record<string, string> = { TW: "🇹🇼 台股", US: "🇺🇸 美股", CRYPTO: "₿ 加密貨幣" };
      const SENT: Record<string, string> = { bullish: "📈 看多", bearish: "📉 看空", neutral: "➡️ 中性" };
      await sendMessage({
        chat_id: msg.chat.id,
        text: [
          "📋 <b>此情報 24 小時內已有人提過</b>，直接沿用分析結果：",
          "",
          `<b>市場：</b>${MARKET[cached.market ?? ""] ?? cached.market}`,
          `<b>方向：</b>${SENT[cached.sentiment ?? ""] ?? cached.sentiment}`,
          cached.confidence != null ? `<b>信心：</b>${cached.confidence}/100` : "",
          cached.ticker ? `<b>主標的：</b>${cached.ticker}` : "",
          cached.summary ? `\n<b>摘要：</b>${cached.summary}` : "",
        ].filter(Boolean).join("\n"),
        parse_mode: "HTML",
      });
      return;
    }
  }

  try {
    const inserted = await db
      .insert(rawMessages)
      .values({
        telegramUpdateId: update.update_id,
        telegramUserId,
        telegramChatId: msg.chat.id,
        telegramMessageId: msg.message_id,
        messageText: finalText,
        messageDate: new Date(msg.date * 1000),
        truncated,
        status: "pending",
        mediaType,
        mediaFileId,
        contentHash,
      })
      .onConflictDoNothing()
      .returning({ id: rawMessages.id });

    // Only ack if we actually stored a new row (not a duplicate update_id)
    if (inserted.length > 0) {
      const ackParts: string[] = [];
      if (mediaType === "photo") ackParts.push("📷 截圖");
      else if (mediaType === "pdf") ackParts.push("📄 PDF");
      else ackParts.push("📝 訊息");
      ackParts.push("已收到，AI 分析中…");

      await sendMessage({
        chat_id: msg.chat.id,
        text: ackParts.join(""),
        parse_mode: "HTML",
      });

      // Trigger classification immediately (fire-and-forget)
      triggerClassifyWorkflow().catch((err) => {
        console.warn("[webhook] classify trigger failed:", err);
      });
    }
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
          "/q 股票代號 — 查詢某支股票的所有情報",
          "/stats — 查看情報總覽統計",
          "/help — 顯示此說明",
          "",
          "（管理員限定）",
          "/invite — 產生新邀請碼",
          "",
          "範例：",
          "<code>/q 2330</code>　<code>/q NVDA</code>　<code>/q BTC</code>",
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
      const botLink = `https://t.me/FF_tradinginfo_bot?start=${code}`;
      await sendMessage({
        chat_id: chatId,
        text: [
          "🎟 <b>邀請連結已產生</b>",
          "",
          `<b>邀請碼：</b><code>${code}</code>`,
          "",
          "<b>傳給對方這個連結：</b>",
          botLink,
          "",
          "對方點擊後在 Telegram 開啟，即可自動加入，無需填寫任何資料。",
        ].join("\n"),
        parse_mode: "HTML",
      });
      return;
    }

    if (command === "/q") {
      const parts = rawCommand.trim().split(/\s+/);
      const rawSymbol = parts[1]?.toUpperCase() ?? "";

      if (!rawSymbol) {
        await sendMessage({
          chat_id: chatId,
          text: "❓ 用法：<code>/q 股票代號</code>\n例如：<code>/q 2330</code>、<code>/q NVDA</code>、<code>/q BTC</code>",
          parse_mode: "HTML",
        });
        return;
      }

      // Expand bare Taiwan 4-6 digit codes to .TW / .TWO variants
      const variants: string[] = [rawSymbol];
      if (/^\d{4,6}$/.test(rawSymbol)) {
        variants.push(`${rawSymbol}.TW`, `${rawSymbol}.TWO`);
      }

      const rows = await db
        .select({
          sentiment: tipTickers.sentiment,
          targetPrice: tipTickers.targetPrice,
          summary: tips.summary,
          confidence: tips.confidence,
          market: tips.market,
          createdAt: tips.createdAt,
        })
        .from(tipTickers)
        .innerJoin(tips, eq(tipTickers.tipId, tips.id))
        .where(inArray(tipTickers.symbol, variants))
        .orderBy(desc(tips.createdAt))
        .limit(20);

      if (rows.length === 0) {
        await sendMessage({
          chat_id: chatId,
          text: `找不到 <b>${rawSymbol}</b> 的情報記錄。\n\n可能原因：\n• 代號不正確（台股請用 4 位數字，如 <code>2330</code>）\n• 尚未有任何情報提及此標的`,
          parse_mode: "HTML",
        });
        return;
      }

      const total = rows.length;
      const bullish = rows.filter((r) => r.sentiment === "bullish").length;
      const bearish = rows.filter((r) => r.sentiment === "bearish").length;
      const neutral = rows.filter((r) => r.sentiment === "neutral").length;

      // Format recent tips (up to 5)
      const recentLines = rows.slice(0, 5).map((r) => {
        const icon =
          r.sentiment === "bullish" ? "📈" : r.sentiment === "bearish" ? "📉" : "➡️";
        const date = new Date(r.createdAt).toLocaleDateString("zh-TW", {
          month: "2-digit",
          day: "2-digit",
        });
        const target = r.targetPrice ? ` 目標 ${parseFloat(r.targetPrice).toLocaleString()}` : "";
        const conf = r.confidence != null ? ` (${r.confidence}分)` : "";
        const summary = r.summary ? `\n  ${r.summary}` : "";
        return `• ${date} ${icon}${target}${conf}${summary}`;
      });

      const lines = [
        `📊 <b>${rawSymbol} 情報查詢</b>`,
        "",
        `<b>共 ${total} 筆情報</b>`,
        "",
        `📈 看多 ${bullish}　📉 看空 ${bearish}　➡️ 中性 ${neutral}`,
        "",
        "<b>最近情報：</b>",
        ...recentLines,
      ];

      if (total > 5) {
        lines.push("", `⋯ 顯示最近 5 筆，共 ${total} 筆`);
      }

      await sendMessage({
        chat_id: chatId,
        text: lines.join("\n"),
        parse_mode: "HTML",
      });
      return;
    }

    if (command === "/stats") {
      const rows = await db
        .select({ market: tips.market, sentiment: tips.sentiment })
        .from(tips);

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
          "📊 <b>情報總覽</b>",
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

// ─── T14: Telegram invite redemption (/start CODE) ───────────────────────────

async function handleInviteRedemption(
  code: string,
  telegramUserId: number,
  chatId: number
): Promise<void> {
  // Already a member?
  const [existing] = await db
    .select({ id: userProfiles.id })
    .from(userProfiles)
    .where(eq(userProfiles.telegramId, telegramUserId))
    .limit(1);

  if (existing) {
    await sendMessage({
      chat_id: chatId,
      text: "✅ 你已經是成員了！輸入 /help 查看可用指令。",
      parse_mode: "HTML",
    });
    return;
  }

  const now = new Date();

  // Validate invite code
  const [invite] = await db
    .select({ id: inviteCodes.id, createdBy: inviteCodes.createdBy })
    .from(inviteCodes)
    .where(
      and(
        eq(inviteCodes.code, code),
        eq(inviteCodes.isRevoked, false),
        isNull(inviteCodes.usedAt)
      )
    )
    .limit(1);

  if (!invite) {
    await sendMessage({
      chat_id: chatId,
      text: "❌ 邀請連結無效、已過期或已被使用。\n請向管理員申請新的邀請連結。",
      parse_mode: "HTML",
    });
    return;
  }

  try {
    // Create a ghost Supabase auth user to satisfy the FK constraint.
    // Telegram-only users never log in via the web, but the FK requires
    // a matching auth.users row.
    const admin = createSupabaseAdminClient();
    const ghostEmail = `tg_${telegramUserId}@telegram.local`;
    const { data: authData, error: authErr } = await admin.auth.admin.createUser({
      email: ghostEmail,
      email_confirm: true,
      user_metadata: { telegram_id: telegramUserId, signup_via: "telegram_invite" },
    });

    if (authErr || !authData.user) {
      throw new Error(`auth_create_failed: ${authErr?.message ?? "unknown"}`);
    }

    const userId = authData.user.id;

    await db.transaction(async (tx) => {
      await tx.insert(userProfiles).values({
        id: userId,
        telegramId: telegramUserId,
        role: "member",
        invitedBy: invite.createdBy,
      }).onConflictDoNothing();

      await tx
        .update(inviteCodes)
        .set({ usedBy: userId, usedAt: now })
        .where(and(eq(inviteCodes.id, invite.id), isNull(inviteCodes.usedAt)));
    });

    await sendMessage({
      chat_id: chatId,
      text: [
        "🎉 <b>歡迎加入！</b>",
        "",
        "你已成功加入，現在可以直接傳送交易情報。",
        "AI 會自動分類，你確認後記錄進資料庫。",
        "",
        "輸入 /help 查看說明。",
      ].join("\n"),
      parse_mode: "HTML",
    });
  } catch (err) {
    console.error("[webhook] invite redemption error:", err);
    await sendMessage({
      chat_id: chatId,
      text: "⚠️ 加入失敗，請稍後再試或聯絡管理員。",
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
  const [row] = await db
    .insert(inviteCodes)
    .values({ code, createdBy })
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

async function triggerClassifyWorkflow(): Promise<void> {
  const token = process.env["GH_PAT"];
  if (!token) return; // no-op if not configured

  const res = await fetch(
    "https://api.github.com/repos/wxes9250802-FF/trading-wiki/actions/workflows/classify-messages.yml/dispatches",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: "main" }),
    }
  );

  // 204 = success, anything else is an error
  if (!res.ok && res.status !== 204) {
    throw new Error(`GitHub API ${res.status}`);
  }
}

function resolveMedia(msg: TelegramMessage): { mediaType: string | null; mediaFileId: string | null } {
  if (msg.photo?.length) {
    const largest = msg.photo[msg.photo.length - 1]!;
    return { mediaType: "photo", mediaFileId: largest.file_id };
  }
  if (msg.document?.mime_type === "application/pdf") {
    return { mediaType: "pdf", mediaFileId: msg.document.file_id };
  }
  return { mediaType: null, mediaFileId: null };
}

function ok() {
  return new NextResponse(null, { status: 200 });
}
