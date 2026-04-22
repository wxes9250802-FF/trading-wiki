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
import { pendingImports } from "@/lib/db/schema/pending-imports";
import type { PendingImportItem } from "@/lib/db/schema/pending-imports";
import {
  answerCallbackQuery,
  editMessageReplyMarkup,
  sendMessage,
} from "@/lib/telegram/client";
import type { TelegramUpdate, TelegramCallbackQuery, TelegramMessage } from "@/lib/telegram/types";
import { buyHolding, sellHolding, listPortfolio } from "@/lib/holdings/manager";
import { parseHoldingsPhoto } from "@/lib/holdings/import-from-photo";
import { resolveTicker } from "@/lib/ticker/resolver";
import { holdings as holdingsTable } from "@/lib/db/schema/holdings";
import { priceAlerts } from "@/lib/db/schema/price-alerts";

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

  // Holdings import: photo with /import or /匯入 caption
  const captionCommand = text.toLowerCase();
  if (captionCommand === "/import" || captionCommand === "/匯入") {
    const hasPhoto = !!(msg.photo?.length);
    if (!hasPhoto) {
      await sendMessage({
        chat_id: msg.chat.id,
        text: "❓ 請連同持股截圖一起傳送 /import",
        parse_mode: "HTML",
      });
      return;
    }
    await handleImportPhoto(profile.id, msg.chat.id, msg.photo!);
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
        industryCategory: tips.industryCategory,
        sectorPosition: tips.sectorPosition,
        companyDescription: tips.companyDescription,
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
      const SENT: Record<string, string> = { bullish: "📈 看多", bearish: "📉 看空", neutral: "➡️ 中性" };
      const dedupLines = [
        "📋 <b>此情報 24 小時內已有人提過</b>，直接沿用分析結果：",
        "",
        `<b>方向：</b>${SENT[cached.sentiment ?? ""] ?? cached.sentiment}`,
        cached.confidence != null ? `<b>信心：</b>${cached.confidence}/100` : "",
        cached.ticker ? `<b>主標的：</b>${cached.ticker}` : "",
        cached.industryCategory ? `<b>產業：</b>${cached.industryCategory}` : "",
        cached.sectorPosition ? `<b>地位：</b>${cached.sectorPosition}` : "",
        cached.companyDescription ? `\n💼 ${cached.companyDescription}` : "",
        cached.summary ? `\n<b>摘要：</b>${cached.summary}` : "",
      ];
      await sendMessage({
        chat_id: msg.chat.id,
        text: dedupLines.filter(Boolean).join("\n"),
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
          "📦 <b>持股管理：</b>",
          "/buy 代號 張數 成本 — 買入，例如 <code>/buy 2330 10 985.5</code>",
          "/sell 代號 張數 賣價 — 賣出，例如 <code>/sell 2330 5 1050</code>",
          "/portfolio — 查看我的持股與損益",
          "（傳圖時 caption 寫 /import — 截圖批次匯入）",
          "",
          "🔔 <b>盤中警示：</b>",
          "/alert 代號 +漲% -跌% vol 量倍數 — 設定警示條件",
          "  例如 <code>/alert 2330 +3 -5</code>（漲 3% 或跌 5% 通知）",
          "  或 <code>/alert 2330 -5 vol 2</code>（跌 5% 或量 2 倍通知）",
          "/alerts — 列出所有已設定的警示",
          "/unalert 代號 — 移除某檔警示",
          "",
          "（管理員限定）",
          "/invite — 產生新邀請碼",
          "",
          "範例：",
          "<code>/q 2330</code>　<code>/alert 2330 +5 -3</code>",
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
          industryCategory: tips.industryCategory,
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

      // Pick the first available industry category from recent tips
      const industryCat = rows.find((r) => r.industryCategory)?.industryCategory ?? null;
      const titleLine = industryCat
        ? `📊 <b>${rawSymbol} 情報查詢</b> ｜ ${industryCat}`
        : `📊 <b>${rawSymbol} 情報查詢</b>`;

      const lines = [
        titleLine,
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
        .select({ sentiment: tips.sentiment })
        .from(tips);

      const total = rows.length;
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
          "<b>方向分佈：</b>",
          `📈 看多：${bullish} 筆`,
          `📉 看空：${bearish} 筆`,
          `➡️ 中性：${neutral} 筆`,
        ].join("\n"),
        parse_mode: "HTML",
      });
      return;
    }

    if (command === "/buy") {
      await handleBuy(rawCommand, profile.id, chatId);
      return;
    }

    if (command === "/sell") {
      await handleSell(rawCommand, profile.id, chatId);
      return;
    }

    if (command === "/portfolio") {
      await handlePortfolio(profile.id, chatId);
      return;
    }

    if (command === "/alert") {
      await handleAlertSet(rawCommand, profile.id, chatId);
      return;
    }

    if (command === "/alerts") {
      await handleAlertList(profile.id, chatId);
      return;
    }

    if (command === "/unalert") {
      await handleAlertRemove(rawCommand, profile.id, chatId);
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

// ─── Holdings: /buy ───────────────────────────────────────────────────────────

async function handleBuy(
  rawCommand: string,
  userId: string,
  chatId: number
): Promise<void> {
  const parts = rawCommand.trim().split(/\s+/);
  // /buy <symbol> <lots> <price>
  const rawSymbol = parts[1] ?? "";
  const rawLots = parts[2] ?? "";
  const rawPrice = parts[3] ?? "";

  if (!rawSymbol || !rawLots || !rawPrice) {
    await sendMessage({
      chat_id: chatId,
      text: "❓ 用法：<code>/buy 代號 張數 成本</code>\n例如：<code>/buy 2330 10 985.5</code>",
      parse_mode: "HTML",
    });
    return;
  }

  // 只接受台股 4-6 位代碼
  if (!/^\d{4,6}$/.test(rawSymbol)) {
    await sendMessage({
      chat_id: chatId,
      text: "❌ 股票代號格式錯誤，請輸入 4-6 位台股代碼，例如 <code>2330</code>",
      parse_mode: "HTML",
    });
    return;
  }

  const sharesLots = parseFloat(rawLots);
  const price = parseFloat(rawPrice);

  if (!isFinite(sharesLots) || sharesLots <= 0) {
    await sendMessage({
      chat_id: chatId,
      text: "❌ 張數必須大於 0",
      parse_mode: "HTML",
    });
    return;
  }

  if (!isFinite(price) || price <= 0) {
    await sendMessage({
      chat_id: chatId,
      text: "❌ 成本價必須大於 0",
      parse_mode: "HTML",
    });
    return;
  }

  // 正規化 symbol：查 tickers 表
  const ticker = await resolveTicker(rawSymbol);
  const symbol = ticker?.symbol ?? `${rawSymbol}.TW`;
  const displayName = ticker?.name ?? rawSymbol;

  try {
    const result = await buyHolding({ userId, symbol, sharesLots, price });
    await sendMessage({
      chat_id: chatId,
      text: [
        `✅ 已記錄 買入 ${rawSymbol} ${displayName} ${sharesLots} 張 @${price.toFixed(2)}`,
        `持股更新為 ${result.sharesLots} 張，均價 ${result.avgCost.toFixed(2)}`,
      ].join("\n"),
      parse_mode: "HTML",
    });

    // Only prompt if user has no alert for this symbol yet
    const [existing] = await db
      .select({ id: priceAlerts.id })
      .from(priceAlerts)
      .where(and(eq(priceAlerts.userId, userId), eq(priceAlerts.symbol, symbol)))
      .limit(1);
    if (!existing) {
      await sendAlertSetupPrompt(chatId, symbol, displayName);
    }
  } catch (err) {
    console.error("[webhook] buyHolding error:", err);
    await sendMessage({
      chat_id: chatId,
      text: "⚠️ 買入記錄失敗，請稍後再試。",
      parse_mode: "HTML",
    });
  }
}

// ─── Holdings: /sell ──────────────────────────────────────────────────────────

async function handleSell(
  rawCommand: string,
  userId: string,
  chatId: number
): Promise<void> {
  const parts = rawCommand.trim().split(/\s+/);
  const rawSymbol = parts[1] ?? "";
  const rawLots = parts[2] ?? "";
  const rawPrice = parts[3] ?? "";

  if (!rawSymbol || !rawLots || !rawPrice) {
    await sendMessage({
      chat_id: chatId,
      text: "❓ 用法：<code>/sell 代號 張數 賣價</code>\n例如：<code>/sell 2330 5 1050</code>",
      parse_mode: "HTML",
    });
    return;
  }

  if (!/^\d{4,6}$/.test(rawSymbol)) {
    await sendMessage({
      chat_id: chatId,
      text: "❌ 股票代號格式錯誤，請輸入 4-6 位台股代碼，例如 <code>2330</code>",
      parse_mode: "HTML",
    });
    return;
  }

  const sharesLots = parseFloat(rawLots);
  const price = parseFloat(rawPrice);

  if (!isFinite(sharesLots) || sharesLots <= 0) {
    await sendMessage({
      chat_id: chatId,
      text: "❌ 張數必須大於 0",
      parse_mode: "HTML",
    });
    return;
  }

  if (!isFinite(price) || price <= 0) {
    await sendMessage({
      chat_id: chatId,
      text: "❌ 賣出價必須大於 0",
      parse_mode: "HTML",
    });
    return;
  }

  const ticker = await resolveTicker(rawSymbol);
  const symbol = ticker?.symbol ?? `${rawSymbol}.TW`;
  const displayName = ticker?.name ?? rawSymbol;

  try {
    // 先查均價（用於計算實現損益）
    const [existing] = await db
      .select({ avgCost: holdingsTable.avgCost })
      .from(holdingsTable)
      .where(and(eq(holdingsTable.userId, userId), eq(holdingsTable.symbol, symbol)))
      .limit(1);

    const avgCost = existing ? parseFloat(existing.avgCost) : null;

    const result = await sellHolding({ userId, symbol, sharesLots, price });

    // 計算實現損益
    let pnlText = "";
    if (avgCost !== null) {
      const realizedPnl = (price - avgCost) * sharesLots * 1000;
      const pnlPct = avgCost > 0 ? ((price - avgCost) / avgCost) * 100 : 0;
      const sign = realizedPnl >= 0 ? "+" : "";
      pnlText = `\n實現損益：${sign}NT$${realizedPnl.toLocaleString("zh-TW", { maximumFractionDigits: 0 })}（${sign}${pnlPct.toFixed(1)}%）`;
    }

    const afterText = result === null
      ? "持股已全數賣出"
      : `剩餘 ${result.sharesLots} 張，均價 ${result.avgCost.toFixed(2)}`;

    await sendMessage({
      chat_id: chatId,
      text: [
        `✅ 已記錄 賣出 ${rawSymbol} ${displayName} ${sharesLots} 張 @${price.toFixed(2)}`,
        afterText + pnlText,
      ].join("\n"),
      parse_mode: "HTML",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "";
    if (msg.startsWith("NO_HOLDING:")) {
      const sym = msg.split(":")[1] ?? rawSymbol;
      await sendMessage({
        chat_id: chatId,
        text: `❌ 你沒有持有 ${sym} 的倉位`,
        parse_mode: "HTML",
      });
    } else if (msg.startsWith("INSUFFICIENT:")) {
      const parts2 = msg.split(":");
      const sym = parts2[1] ?? rawSymbol;
      const current = parts2[2] ?? "0";
      await sendMessage({
        chat_id: chatId,
        text: `❌ 持有不足，${sym} 目前只有 ${current} 張`,
        parse_mode: "HTML",
      });
    } else {
      console.error("[webhook] sellHolding error:", err);
      await sendMessage({
        chat_id: chatId,
        text: "⚠️ 賣出記錄失敗，請稍後再試。",
        parse_mode: "HTML",
      });
    }
  }
}

// ─── Holdings: /portfolio ─────────────────────────────────────────────────────

async function handlePortfolio(userId: string, chatId: number): Promise<void> {
  try {
    const rows = await listPortfolio(userId);

    if (rows.length === 0) {
      await sendMessage({
        chat_id: chatId,
        text: "📭 你目前沒有持股，使用 /buy 開始記錄",
        parse_mode: "HTML",
      });
      return;
    }

    const lines: string[] = ["📊 <b>我的持股</b>", ""];

    let totalCost = 0;
    let totalValue = 0;
    let allHavePrice = true;

    rows.forEach((row, idx) => {
      const shortSymbol = row.symbol.replace(/\.(TW|TWO)$/, "");
      const lotsStr = row.sharesLots % 1 === 0
        ? String(row.sharesLots)
        : row.sharesLots.toFixed(1);

      lines.push(`${idx + 1}. <b>${shortSymbol}</b> ${lotsStr} 張 @${row.avgCost.toFixed(2)}`);

      if (row.currentPrice !== null && row.marketValue !== null && row.pnl !== null && row.pnlPct !== null) {
        const sign = row.pnl >= 0 ? "+" : "";
        const pnlSign = row.pnl >= 0 ? "+" : "";
        lines.push(
          `   現價 ${row.currentPrice.toFixed(2)}（${sign}${row.pnlPct.toFixed(2)}%）`
        );
        lines.push(
          `   市值 NT$${row.marketValue.toLocaleString("zh-TW", { maximumFractionDigits: 0 })}（${pnlSign}NT$${Math.abs(row.pnl).toLocaleString("zh-TW", { maximumFractionDigits: 0 })}）`
        );
        totalValue += row.marketValue;
      } else {
        lines.push("   現價 無法取得");
        allHavePrice = false;
        totalValue += row.costBasis; // fallback
      }

      totalCost += row.costBasis;
      lines.push("");
    });

    lines.push("---");
    lines.push(`總成本：NT$${totalCost.toLocaleString("zh-TW", { maximumFractionDigits: 0 })}`);

    if (allHavePrice) {
      const totalPnl = totalValue - totalCost;
      const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;
      const sign = totalPnl >= 0 ? "+" : "";
      lines.push(`總市值：NT$${totalValue.toLocaleString("zh-TW", { maximumFractionDigits: 0 })}`);
      lines.push(
        `未實現損益：${sign}NT$${Math.abs(totalPnl).toLocaleString("zh-TW", { maximumFractionDigits: 0 })}（${sign}${totalPnlPct.toFixed(2)}%）`
      );
    } else {
      lines.push("（部分持股無法取得即時行情，損益計算不完整）");
    }

    await sendMessage({
      chat_id: chatId,
      text: lines.join("\n"),
      parse_mode: "HTML",
    });
  } catch (err) {
    console.error("[webhook] handlePortfolio error:", err);
    await sendMessage({
      chat_id: chatId,
      text: "⚠️ 查詢持股失敗，請稍後再試。",
      parse_mode: "HTML",
    });
  }
}

// ─── Price alerts: /alert / /alerts / /unalert ────────────────────────────────

/**
 * Parse /alert tokens. Accepts:
 *   /alert 2330 +3 -5           → up=3, down=-5
 *   /alert 2330 -5              → down=-5 only
 *   /alert 2330 +3              → up=3 only
 *   /alert 2330 vol 2.5         → volume only
 *   /alert 2330 +3 -5 vol 2     → all three
 * Returns null on invalid input.
 */
function parseAlertTokens(tokens: string[]): {
  upPct: number | null;
  downPct: number | null;
  volumeMultiplier: number | null;
} | null {
  let upPct: number | null = null;
  let downPct: number | null = null;
  let volumeMultiplier: number | null = null;

  let i = 0;
  while (i < tokens.length) {
    const tok = tokens[i]!.trim();
    if (!tok) {
      i++;
      continue;
    }

    if (tok.toLowerCase() === "vol") {
      const next = tokens[i + 1];
      const num = parseFloat(next ?? "");
      if (!isFinite(num) || num <= 0) return null;
      volumeMultiplier = num;
      i += 2;
      continue;
    }

    // +N or -N
    const match = /^([+\-])(\d+(?:\.\d+)?)$/.exec(tok);
    if (!match) return null;
    const sign = match[1];
    const num = parseFloat(match[2]!);
    if (!isFinite(num) || num <= 0) return null;

    if (sign === "+") upPct = num;
    else downPct = -num;

    i++;
  }

  // At least one must be set
  if (upPct === null && downPct === null && volumeMultiplier === null) return null;

  return { upPct, downPct, volumeMultiplier };
}

function formatAlertLine(row: {
  symbol: string;
  upPct: string | null;
  downPct: string | null;
  volumeMultiplier: string | null;
}): string {
  const parts: string[] = [];
  if (row.upPct !== null) parts.push(`漲 ≥ ${parseFloat(row.upPct).toFixed(1)}%`);
  if (row.downPct !== null) parts.push(`跌 ≤ ${parseFloat(row.downPct).toFixed(1)}%`);
  if (row.volumeMultiplier !== null) parts.push(`量 × ${parseFloat(row.volumeMultiplier).toFixed(1)}`);
  return `${row.symbol} ｜ ${parts.join("  ")}`;
}

async function handleAlertSet(
  rawCommand: string,
  userId: string,
  chatId: number
): Promise<void> {
  const parts = rawCommand.trim().split(/\s+/).slice(1); // drop "/alert"
  const rawSymbolToken = parts[0] ?? "";

  if (!rawSymbolToken) {
    await sendMessage({
      chat_id: chatId,
      text: [
        "❓ <b>用法：</b>",
        "<code>/alert 代號 +漲% -跌% vol 量倍數</code>",
        "",
        "<b>範例：</b>",
        "<code>/alert 2330 +3 -5</code>（漲 3% 或跌 5% 通知）",
        "<code>/alert 2330 -5</code>（只跌 5% 通知）",
        "<code>/alert 2330 vol 2.5</code>（只量 2.5 倍通知）",
        "<code>/alert 2330 +3 -5 vol 2</code>（全部）",
      ].join("\n"),
      parse_mode: "HTML",
    });
    return;
  }

  const rawSymbol = rawSymbolToken.toUpperCase();
  if (!/^\d{4,6}$/.test(rawSymbol)) {
    await sendMessage({
      chat_id: chatId,
      text: "❌ 代號格式錯誤，台股請用 4-6 位數字，例如 <code>2330</code>",
      parse_mode: "HTML",
    });
    return;
  }

  const parsed = parseAlertTokens(parts.slice(1));
  if (!parsed) {
    await sendMessage({
      chat_id: chatId,
      text: "❌ 門檻格式錯誤，至少需要一個 <code>+N</code>、<code>-N</code>、或 <code>vol N</code>",
      parse_mode: "HTML",
    });
    return;
  }

  // Resolve symbol
  const ticker = await resolveTicker(rawSymbol);
  if (!ticker) {
    await sendMessage({
      chat_id: chatId,
      text: `❌ 找不到代號 <code>${rawSymbol}</code>，請確認是台股代碼。`,
      parse_mode: "HTML",
    });
    return;
  }

  const { upPct, downPct, volumeMultiplier } = parsed;

  // Upsert
  await db
    .insert(priceAlerts)
    .values({
      userId,
      symbol: ticker.symbol,
      upPct: upPct !== null ? upPct.toString() : null,
      downPct: downPct !== null ? downPct.toString() : null,
      volumeMultiplier: volumeMultiplier !== null ? volumeMultiplier.toString() : null,
      enabled: true,
    })
    .onConflictDoUpdate({
      target: [priceAlerts.userId, priceAlerts.symbol],
      set: {
        upPct: upPct !== null ? upPct.toString() : null,
        downPct: downPct !== null ? downPct.toString() : null,
        volumeMultiplier: volumeMultiplier !== null ? volumeMultiplier.toString() : null,
        enabled: true,
        updatedAt: new Date(),
      },
    });

  const confirmParts: string[] = [];
  if (upPct !== null) confirmParts.push(`漲 ≥ ${upPct.toFixed(1)}%`);
  if (downPct !== null) confirmParts.push(`跌 ≤ ${downPct.toFixed(1)}%`);
  if (volumeMultiplier !== null) confirmParts.push(`量 × ${volumeMultiplier.toFixed(1)}`);

  await sendMessage({
    chat_id: chatId,
    text: [
      `🔔 <b>已設定警示</b>`,
      "",
      `<b>標的：</b>${ticker.symbol}`,
      `<b>條件：</b>${confirmParts.join("  ／  ")}`,
      "",
      `盤中 09:30-13:30 每小時自動檢查，觸發時通知你。`,
    ].join("\n"),
    parse_mode: "HTML",
  });
}

async function handleAlertList(userId: string, chatId: number): Promise<void> {
  const rows = await db
    .select({
      symbol: priceAlerts.symbol,
      upPct: priceAlerts.upPct,
      downPct: priceAlerts.downPct,
      volumeMultiplier: priceAlerts.volumeMultiplier,
      enabled: priceAlerts.enabled,
    })
    .from(priceAlerts)
    .where(eq(priceAlerts.userId, userId))
    .orderBy(priceAlerts.symbol);

  if (rows.length === 0) {
    await sendMessage({
      chat_id: chatId,
      text: [
        "📭 你尚未設定任何盤中警示。",
        "",
        "用 <code>/alert 代號 條件</code> 開始設定，例如：",
        "<code>/alert 2330 +3 -5</code>",
      ].join("\n"),
      parse_mode: "HTML",
    });
    return;
  }

  const active = rows.filter((r) => r.enabled);
  const disabled = rows.filter((r) => !r.enabled);

  const lines: string[] = [];
  lines.push(`🔔 <b>你的盤中警示（${active.length} 檔）</b>`);
  lines.push("");

  active.forEach((r, idx) => {
    lines.push(`${idx + 1}. ${formatAlertLine(r)}`);
  });

  if (disabled.length > 0) {
    lines.push("");
    lines.push(`（已停用 ${disabled.length} 檔）`);
  }

  lines.push("");
  lines.push(`用 <code>/unalert 代號</code> 移除警示`);

  await sendMessage({
    chat_id: chatId,
    text: lines.join("\n"),
    parse_mode: "HTML",
  });
}

async function handleAlertRemove(
  rawCommand: string,
  userId: string,
  chatId: number
): Promise<void> {
  const parts = rawCommand.trim().split(/\s+/);
  const rawSymbolToken = parts[1] ?? "";

  if (!rawSymbolToken) {
    await sendMessage({
      chat_id: chatId,
      text: "❓ 用法：<code>/unalert 代號</code>，例如 <code>/unalert 2330</code>",
      parse_mode: "HTML",
    });
    return;
  }

  const rawSymbol = rawSymbolToken.toUpperCase();
  const ticker = await resolveTicker(rawSymbol);
  const targetSymbol = ticker?.symbol ?? rawSymbol;

  const deleted = await db
    .delete(priceAlerts)
    .where(
      and(
        eq(priceAlerts.userId, userId),
        eq(priceAlerts.symbol, targetSymbol)
      )
    )
    .returning({ symbol: priceAlerts.symbol });

  if (deleted.length === 0) {
    await sendMessage({
      chat_id: chatId,
      text: `ℹ️ 找不到 <code>${targetSymbol}</code> 的警示設定（可能已被移除或從未設定）。`,
      parse_mode: "HTML",
    });
    return;
  }

  await sendMessage({
    chat_id: chatId,
    text: `✅ 已移除 <code>${targetSymbol}</code> 的盤中警示。`,
    parse_mode: "HTML",
  });
}

// ─── Alert setup: inline-keyboard prompt after /buy and /import ──────────────

/**
 * Send a "pick an alert preset" prompt with inline buttons.
 * callback_data format: "alert:{symbol}:{preset}" where preset ∈
 *   "3" | "5" | "7" | "10" | "skip"
 *
 * The caller has NOT saved an alert yet — this prompt is the opt-in.
 */
async function sendAlertSetupPrompt(
  chatId: number,
  symbol: string,
  displayName?: string
): Promise<void> {
  const label = displayName ? `${symbol} ${displayName}` : symbol;
  await sendMessage({
    chat_id: chatId,
    text: [
      `🔔 <b>為 ${label} 設定警示</b>`,
      "",
      "選一個門檻（漲跌都會通知）：",
      "",
      `單邊或自訂：<code>/alert ${symbol} +漲% -跌%</code>`,
    ].join("\n"),
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "±3%", callback_data: `alert:${symbol}:3` },
          { text: "±5%", callback_data: `alert:${symbol}:5` },
          { text: "±7%", callback_data: `alert:${symbol}:7` },
          { text: "±10%", callback_data: `alert:${symbol}:10` },
        ],
        [{ text: "略過", callback_data: `alert:${symbol}:skip` }],
      ],
    },
  });
}

/**
 * Handle a tap on an alert-setup preset button.
 * Verifies the tapper is the owner (via telegram_id lookup), writes the alert
 * (or skips), then strips the buttons from the original message.
 */
async function handleAlertSetupCallback(
  query: TelegramCallbackQuery,
  data: string
): Promise<void> {
  // data: "alert:{symbol}:{preset}"
  // Symbol can contain "." so we split cleverly from both ends
  const rest = data.slice("alert:".length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon < 0) {
    await answerCallbackQuery({ callback_query_id: query.id });
    return;
  }
  const symbol = rest.slice(0, lastColon);
  const preset = rest.slice(lastColon + 1);

  if (!symbol) {
    await answerCallbackQuery({ callback_query_id: query.id });
    return;
  }

  // Resolve the tapper's user_id via telegram_id
  const [profile] = await db
    .select({ id: userProfiles.id })
    .from(userProfiles)
    .where(eq(userProfiles.telegramId, query.from.id))
    .limit(1);

  if (!profile) {
    await answerCallbackQuery({
      callback_query_id: query.id,
      text: "找不到你的帳號",
      show_alert: true,
    });
    return;
  }

  // Strip buttons first so the UX feels responsive
  if (query.message) {
    await editMessageReplyMarkup({
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
  }

  if (preset === "skip") {
    await answerCallbackQuery({
      callback_query_id: query.id,
      text: "已略過警示設定",
    });
    await sendMessage({
      chat_id: query.from.id,
      text: `⏭ <b>${symbol}</b> 未設定警示。日後可用 <code>/alert ${symbol} +漲% -跌%</code> 自訂。`,
      parse_mode: "HTML",
    });
    return;
  }

  const pct = parseInt(preset, 10);
  if (!Number.isFinite(pct) || pct <= 0) {
    await answerCallbackQuery({ callback_query_id: query.id });
    return;
  }

  const upPct = pct;
  const downPct = -pct;

  await db
    .insert(priceAlerts)
    .values({
      userId: profile.id,
      symbol,
      upPct: upPct.toString(),
      downPct: downPct.toString(),
      volumeMultiplier: null,
      enabled: true,
    })
    .onConflictDoUpdate({
      target: [priceAlerts.userId, priceAlerts.symbol],
      set: {
        upPct: upPct.toString(),
        downPct: downPct.toString(),
        // keep existing volumeMultiplier — user may have set it via /alert
        enabled: true,
        updatedAt: new Date(),
      },
    });

  await answerCallbackQuery({
    callback_query_id: query.id,
    text: `✅ 已設定 ${symbol} ±${pct}% 警示`,
  });

  await sendMessage({
    chat_id: query.from.id,
    text: [
      `🔔 <b>${symbol} 警示已設定</b>`,
      `漲 ≥ ${upPct}% 或跌 ≤ ${downPct}% 會通知你`,
      "",
      `想改門檻：<code>/alert ${symbol} +X -Y</code>`,
      `關閉：<code>/unalert ${symbol}</code>`,
    ].join("\n"),
    parse_mode: "HTML",
  });
}

// ─── Holdings: photo import ───────────────────────────────────────────────────

async function handleImportPhoto(
  userId: string,
  chatId: number,
  photos: NonNullable<TelegramMessage["photo"]>
): Promise<void> {
  // Use the largest photo size
  const largest = photos[photos.length - 1]!;
  const fileId = largest.file_id;

  // Download from Telegram
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    await sendMessage({
      chat_id: chatId,
      text: "⚠️ Bot token 未設定，無法下載圖片。",
      parse_mode: "HTML",
    });
    return;
  }

  let base64: string;
  try {
    // Get file path
    const fileRes = await fetch(
      `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`
    );
    const fileData = (await fileRes.json()) as { ok: boolean; result?: { file_path?: string } };
    if (!fileData.ok || !fileData.result?.file_path) {
      throw new Error("getFile failed");
    }

    const filePath = fileData.result.file_path;
    const dlRes = await fetch(
      `https://api.telegram.org/file/bot${token}/${filePath}`
    );
    if (!dlRes.ok) throw new Error(`Download failed: ${dlRes.status}`);

    const buffer = await dlRes.arrayBuffer();
    base64 = Buffer.from(buffer).toString("base64");
  } catch (err) {
    console.error("[webhook] photo download error:", err);
    await sendMessage({
      chat_id: chatId,
      text: "⚠️ 圖片下載失敗，請稍後再試。",
      parse_mode: "HTML",
    });
    return;
  }

  // Parse via Claude Vision
  await sendMessage({
    chat_id: chatId,
    text: "🔍 正在解析持股截圖，請稍候…",
    parse_mode: "HTML",
  });

  const rawItems = await parseHoldingsPhoto(base64);

  if (!rawItems || rawItems.length === 0) {
    await sendMessage({
      chat_id: chatId,
      text: "❌ 無法從截圖辨識持股資料，請確認是台股券商 APP 的持股明細頁面。",
      parse_mode: "HTML",
    });
    return;
  }

  // Hard cap: AI hallucination defence. One screenshot realistically <= 30 items.
  const items = rawItems.slice(0, 50);

  // Remove any prior pending imports from this user — only one active at a time
  await db.delete(pendingImports).where(eq(pendingImports.userId, userId));

  // Store in pending_imports
  const [pending] = await db
    .insert(pendingImports)
    .values({
      userId,
      payload: items as unknown as typeof pendingImports.$inferInsert["payload"],
    })
    .returning({ id: pendingImports.id });

  if (!pending) {
    await sendMessage({
      chat_id: chatId,
      text: "⚠️ 暫存失敗，請稍後再試。",
      parse_mode: "HTML",
    });
    return;
  }

  // Format preview
  const previewLines = items.map((item, idx) => {
    const lotsStr = item.sharesLots % 1 === 0
      ? String(item.sharesLots)
      : item.sharesLots.toFixed(1);
    return `${idx + 1}. ${item.symbol}　${lotsStr} 張　@${item.avgCost.toFixed(2)}`;
  });

  await sendMessage({
    chat_id: chatId,
    text: [
      "📋 <b>從截圖辨識到以下持股，請確認是否匯入：</b>",
      "",
      ...previewLines,
      "",
      "請按下方按鈕確認或取消。",
    ].join("\n"),
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ 確認匯入", callback_data: `import:${pending.id}:confirm` },
          { text: "❌ 取消", callback_data: `import:${pending.id}:cancel` },
        ],
      ],
    },
  });
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

  // ── Import callback: "import:{uuid}:confirm" or "import:{uuid}:cancel" ───
  if (data.startsWith("import:")) {
    await handleImportCallback(query, data);
    return;
  }

  // ── Alert setup: "alert:{symbol}:{preset}" where preset ∈ {3,5,7,10,skip} ─
  if (data.startsWith("alert:")) {
    await handleAlertSetupCallback(query, data);
    return;
  }

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

// ─── Import callback handler ─────────────────────────────────────────────────

async function handleImportCallback(
  query: TelegramCallbackQuery,
  data: string
): Promise<void> {
  // data format: "import:{uuid}:confirm" or "import:{uuid}:cancel"
  const parts = data.split(":");
  // parts[0] = "import", parts[1] = uuid, parts[2] = "confirm"|"cancel"
  const pendingId = parts[1];
  const importAction = parts[2];

  if (!pendingId || (importAction !== "confirm" && importAction !== "cancel")) {
    await answerCallbackQuery({ callback_query_id: query.id });
    return;
  }

  // Fetch pending import — enforce 30-minute TTL
  const PENDING_TTL_MS = 30 * 60 * 1000;
  const ttlCutoff = new Date(Date.now() - PENDING_TTL_MS);
  const [pending] = await db
    .select()
    .from(pendingImports)
    .where(
      and(
        eq(pendingImports.id, pendingId),
        gt(pendingImports.createdAt, ttlCutoff)
      )
    )
    .limit(1);

  if (!pending) {
    await answerCallbackQuery({
      callback_query_id: query.id,
      text: "❌ 此匯入請求已過期或不存在（超過 30 分鐘）",
      show_alert: true,
    });
    // Remove buttons
    if (query.message) {
      await editMessageReplyMarkup({
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        reply_markup: { inline_keyboard: [] },
      });
    }
    // Also clean up the stale row if the ID exists but is expired
    await db.delete(pendingImports).where(eq(pendingImports.id, pendingId));
    return;
  }

  // Security: only the owner can confirm/cancel
  // Verify by checking that the telegram user matches the pending import's userId
  const [owner] = await db
    .select({ telegramId: userProfiles.telegramId })
    .from(userProfiles)
    .where(eq(userProfiles.id, pending.userId))
    .limit(1);

  if (!owner || owner.telegramId !== query.from.id) {
    await answerCallbackQuery({
      callback_query_id: query.id,
      text: "你沒有操作這筆匯入的權限",
      show_alert: true,
    });
    return;
  }

  // Remove buttons regardless of action
  if (query.message) {
    await editMessageReplyMarkup({
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      reply_markup: { inline_keyboard: [] },
    });
  }

  if (importAction === "cancel") {
    // Delete pending
    await db.delete(pendingImports).where(eq(pendingImports.id, pendingId));
    await answerCallbackQuery({
      callback_query_id: query.id,
      text: "已取消匯入",
    });
    await sendMessage({
      chat_id: query.from.id,
      text: "❌ <b>已取消持股匯入</b>",
      parse_mode: "HTML",
    });
    return;
  }

  // confirm: write to holdings
  const items = pending.payload as PendingImportItem[];

  // Pre-resolve all symbols so we can reject unknown ones BEFORE writing anything.
  // This prevents partial success with the wrong suffix (e.g. guessing .TW when
  // the stock is actually .TWO), and lets us present a single confirm/reject.
  type ResolvedItem = { symbol: string; sharesLots: number; avgCost: number; rawSymbol: string };
  const resolved: ResolvedItem[] = [];
  const unresolved: string[] = [];
  for (const item of items) {
    const ticker = await resolveTicker(item.symbol);
    if (!ticker) {
      unresolved.push(item.symbol);
      continue;
    }
    resolved.push({
      symbol: ticker.symbol,
      sharesLots: item.sharesLots,
      avgCost: item.avgCost,
      rawSymbol: item.symbol,
    });
  }

  // If ANY row is unresolved, abort the entire import — user should check the list
  // or run /buy manually for the failed ones. This avoids partial-state confusion.
  if (unresolved.length > 0) {
    await db.delete(pendingImports).where(eq(pendingImports.id, pendingId));
    await answerCallbackQuery({
      callback_query_id: query.id,
      text: "❌ 部分代號無法對應，匯入已取消",
    });
    await sendMessage({
      chat_id: query.from.id,
      text: [
        "❌ <b>匯入已取消</b>",
        "",
        `以下代號找不到對應股票：<code>${unresolved.join(", ")}</code>`,
        "",
        "請確認代號正確，或稍後重傳截圖。",
      ].join("\n"),
      parse_mode: "HTML",
    });
    return;
  }

  // All resolved — write atomically. If anything fails, rollback and no rows are written.
  let successCount = 0;
  const errors: string[] = [];
  try {
    for (const r of resolved) {
      await buyHolding({
        userId: pending.userId,
        symbol: r.symbol,
        sharesLots: r.sharesLots,
        price: r.avgCost,
        note: "截圖批次匯入",
      });
      successCount++;
    }
  } catch (err) {
    console.error("[webhook] import confirm transaction error:", err);
    errors.push("寫入時發生錯誤，部分資料可能未完全匯入");
  }

  // Delete pending regardless of success — we don't want retries of the same batch
  await db.delete(pendingImports).where(eq(pendingImports.id, pendingId));

  await answerCallbackQuery({
    callback_query_id: query.id,
    text: `✅ 已匯入 ${successCount} 筆持股`,
  });

  const resultLines = [`✅ <b>持股匯入完成</b>，成功 ${successCount} 筆`];
  if (errors.length > 0) {
    resultLines.push(`⚠️ ${errors.join("；")}`);
  }
  resultLines.push("\n輸入 /portfolio 查看最新持股");

  await sendMessage({
    chat_id: query.from.id,
    text: resultLines.join("\n"),
    parse_mode: "HTML",
  });

  // ── Alert setup prompts — one inline-keyboard per newly imported symbol ──
  // Only prompt for symbols the user doesn't already have an alert on.
  if (successCount > 0) {
    for (const r of resolved) {
      const [existing] = await db
        .select({ id: priceAlerts.id })
        .from(priceAlerts)
        .where(
          and(
            eq(priceAlerts.userId, pending.userId),
            eq(priceAlerts.symbol, r.symbol)
          )
        )
        .limit(1);
      if (!existing) {
        await sendAlertSetupPrompt(query.from.id, r.symbol);
      }
    }
  }
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
