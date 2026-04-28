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
import { eq, and, isNull, gt, gte, inArray, desc, sql } from "drizzle-orm";
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
import { parseHoldingsPhoto, type ParsedHoldingItem } from "@/lib/holdings/import-from-photo";
import { resolveTicker } from "@/lib/ticker/resolver";
import { classifyTwSymbol, classifyMarket } from "@/lib/ticker/classify";
import { fetchInstitutionalInvestors } from "@/lib/finmind/client";
import { fetchLatestQuote } from "@/lib/price/client";
import {
  fetchUsCompanyProfile,
  fetchUsInsiderTransactions,
  fetchUsRecommendations,
} from "@/lib/finnhub/client";
import { upsertUsTicker } from "@/lib/ticker/upsert-us";
import {
  marketFromSymbol,
  sharesPerLot,
  quantityUnit,
  formatMoney,
  type Market,
} from "@/lib/util/units";
import { holdings as holdingsTable } from "@/lib/db/schema/holdings";
import { priceAlerts } from "@/lib/db/schema/price-alerts";
import { tickers } from "@/lib/db/schema/tickers";
import { pendingSells } from "@/lib/db/schema/pending-sells";
import { fetchCurrentPrice } from "@/lib/price/client";
import { formatSymbolName, stripTwSuffix } from "@/lib/util/symbol";

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

  // Interactive /sell continuation: bare number reply consumes pending_sell.
  // Must run BEFORE command + import routing so "3" alone doesn't fall through.
  // Only triggers when user has a non-expired pending_sell and the text is a
  // pure number; otherwise this is a no-op and we fall through.
  if (!msg.photo?.length && msg.document === undefined && /^\d+(\.\d+)?$/.test(text)) {
    const consumed = await tryConsumePendingSellFromText(profile.id, msg.chat.id, text);
    if (consumed) return;
  }

  // Holdings import: /import [tw|us] — supports two markets, photo or text
  //   /import           → show market selector buttons
  //   /import tw + ...  → TW import (photo or text)
  //   /import us + ...  → US import (photo or text)
  const firstLineRaw = text.split(/\r?\n/)[0]!.trim();
  const tokens = firstLineRaw.split(/\s+/);
  const firstWord = tokens[0]!.toLowerCase();
  if (firstWord === "/import" || firstWord === "/匯入") {
    const hasPhotoAttachment = !!(msg.photo?.length);

    // Optional market token: /import tw, /import us
    const second = tokens[1]?.toLowerCase();
    const marketArg: Market | null =
      second === "tw" ? "TW" : second === "us" ? "US" : null;

    // Body = everything after /import [market_token]
    const dropTokens = marketArg ? 2 : 1;
    const firstLineRest = tokens.slice(dropTokens).join(" ");
    const bodyLines = [firstLineRest, ...text.split(/\r?\n/).slice(1)];
    const bodyText = bodyLines.join("\n").trim();

    // No market specified + no body + no photo → show selector buttons
    if (!marketArg && !hasPhotoAttachment && !bodyText) {
      await sendMessage({
        chat_id: msg.chat.id,
        text: [
          "📥 <b>選擇要匯入的市場</b>",
          "",
          "點按鈕後依指示傳送持股截圖或文字。",
        ].join("\n"),
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [[
            { text: "🇹🇼 台股", callback_data: "imp:tw" },
            { text: "🇺🇸 美股", callback_data: "imp:us" },
          ]],
        },
      });
      return;
    }

    // No market specified but has body / photo → ask user to re-send with market
    if (!marketArg) {
      await sendMessage({
        chat_id: msg.chat.id,
        text: [
          "❓ 請指定市場：",
          "• 台股：第一行 <code>/import tw</code>",
          "• 美股：第一行 <code>/import us</code>",
          "",
          "範例（台股文字）：",
          "<pre>/import tw",
          "2330 10 985.5",
          "0050 5 168</pre>",
          "範例（美股文字）：",
          "<pre>/import us",
          "AAPL 5 178",
          "NVDA 3 850</pre>",
          "或截圖上傳，caption 寫 <code>/import tw</code> 或 <code>/import us</code>",
        ].join("\n"),
        parse_mode: "HTML",
      });
      return;
    }

    if (hasPhotoAttachment) {
      await handleImportPhoto(profile.id, msg.chat.id, msg.photo!, marketArg);
      return;
    }
    if (bodyText) {
      await handleImportText(profile.id, msg.chat.id, bodyLines, marketArg);
      return;
    }

    // Just /import tw or /import us alone → tell user what to send
    const flag = marketArg === "TW" ? "🇹🇼 台股" : "🇺🇸 美股";
    await sendMessage({
      chat_id: msg.chat.id,
      text: [
        `📥 <b>${flag} 匯入</b>`,
        "",
        "現在請傳：",
        "• 持股截圖（caption 寫 <code>/import " + marketArg.toLowerCase() + "</code>）",
        "• 或文字（第一行 <code>/import " + marketArg.toLowerCase() + "</code>，後續每行 <code>代號 " + (marketArg === "TW" ? "張數" : "股數") + " 成本</code>）",
      ].join("\n"),
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
      const lines = [
        "🤖 <b>Trading Intelligence Hub</b>",
        "",
        "支援 🇹🇼 台股 + 🇺🇸 美股",
        "",
        "可用指令：",
        "/q 股票代號 — 查詢某支股票（例：<code>/q 2330</code>、<code>/q AAPL</code>）",
        "/stats — 情報總覽（雙市場熱門 / 最新）",
        "/help — 顯示此說明",
        "",
        "📦 <b>持股管理：</b>",
        "/buy 代號 數量 成本 — 買入",
        "  • 台股：<code>/buy 2330 10 985.5</code>（張）",
        "  • 美股：<code>/buy AAPL 5 178</code>（股）",
        "/sell — 互動選單（選持股 → 選數量）",
        "/sell 代號 數量 賣價 — 指定價賣出",
        "/clear — 一鍵清倉（全數以現價賣出）",
        "/portfolio — 查看我的持股（可分台股/美股/全部）",
        "/import — 批次匯入持股：",
        "  <code>/import tw</code> 或 <code>/import us</code> + 文字或截圖",
        "  （僅追蹤股票/ETF；權證自動略過）",
        "",
        "🔔 <b>盤中警示：</b>",
        "/alert 代號 +漲% -跌% vol 量倍數 — 設定警示",
        "  例：<code>/alert 2330 +3 -5</code>、<code>/alert AAPL -3</code>",
        "  美股盤通知時間 21:30-04:00 TST 之間",
        "/alerts — 列出已設定的警示",
        "/unalert 代號 — 移除警示",
      ];
      if (profile.role === "admin") {
        lines.push("", "（管理員限定）", "/invite — 產生新邀請碼");
      }
      lines.push(
        "",
        "範例：",
        "<code>/q 2330</code>　<code>/alert 2330 +5 -3</code>"
      );
      await sendMessage({
        chat_id: chatId,
        text: lines.join("\n"),
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
      await handleQuery(rawCommand, chatId);
      return;
    }

    if (command === "/stats") {
      await handleStats(chatId);
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
      // Optional market arg: /portfolio tw / us / all
      const arg = rawCommand.trim().split(/\s+/)[1]?.toLowerCase();
      if (arg === "tw" || arg === "us" || arg === "all") {
        await handlePortfolio(profile.id, chatId, arg);
      } else {
        // No arg → show selector buttons
        await sendMessage({
          chat_id: chatId,
          text: "📊 <b>選擇要查看的市場：</b>",
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "🇹🇼 台股", callback_data: "pf:tw" },
                { text: "🇺🇸 美股", callback_data: "pf:us" },
              ],
              [{ text: "全部", callback_data: "pf:all" }],
            ],
          },
        });
      }
      return;
    }

    if (command === "/clear" || command === "/清倉") {
      await handleClearPrompt(profile.id, chatId);
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

// ─── /stats — actionable recent-activity digest ─────────────────────────────

async function handleStats(chatId: number): Promise<void> {
  const WINDOW_DAYS = 30;
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  // Dedup key: same content hash → one count. Media (NULL hash) falls back
  // to raw_message id so each media message is its own unit.
  const dedupKey = sql<string>`coalesce(${rawMessages.contentHash}, ${rawMessages.id}::text)`;

  // Run independent queries in parallel — split top symbols/industries by market
  const [
    sentimentRows,
    topSymbolsRaw,
    topIndustriesRaw,
    recentTips,
  ] = await Promise.all([
    db
      .select({
        key: dedupKey,
        sentiment: tips.sentiment,
        market: tips.market,
      })
      .from(tips)
      .innerJoin(aiClassifications, eq(aiClassifications.tipId, tips.id))
      .innerJoin(rawMessages, eq(aiClassifications.rawMessageId, rawMessages.id))
      .where(gte(tips.createdAt, since)),

    // Top symbols grouped by (market, symbol) — slice into TW/US in JS
    db
      .select({
        market: tips.market,
        symbol: tipTickers.symbol,
        total: sql<number>`count(distinct ${dedupKey})::int`,
        bullish: sql<number>`count(distinct ${dedupKey}) filter (where ${tipTickers.sentiment} = 'bullish')::int`,
        bearish: sql<number>`count(distinct ${dedupKey}) filter (where ${tipTickers.sentiment} = 'bearish')::int`,
        neutral: sql<number>`count(distinct ${dedupKey}) filter (where ${tipTickers.sentiment} = 'neutral')::int`,
      })
      .from(tipTickers)
      .innerJoin(tips, eq(tipTickers.tipId, tips.id))
      .innerJoin(aiClassifications, eq(aiClassifications.tipId, tips.id))
      .innerJoin(rawMessages, eq(aiClassifications.rawMessageId, rawMessages.id))
      .where(gte(tips.createdAt, since))
      .groupBy(tips.market, tipTickers.symbol)
      .orderBy(desc(sql`count(distinct ${dedupKey})`)),

    // Industries grouped by (market, industry)
    db
      .select({
        market: tips.market,
        industry: tips.industryCategory,
        count: sql<number>`count(distinct ${dedupKey})::int`,
      })
      .from(tips)
      .innerJoin(aiClassifications, eq(aiClassifications.tipId, tips.id))
      .innerJoin(rawMessages, eq(aiClassifications.rawMessageId, rawMessages.id))
      .where(
        and(
          gte(tips.createdAt, since),
          sql`${tips.industryCategory} is not null`,
          sql`${tips.industryCategory} <> ''`
        )
      )
      .groupBy(tips.market, tips.industryCategory)
      .orderBy(desc(sql`count(distinct ${dedupKey})`)),

    // Most recent 5 tips — chronological feed, NOT deduped, mixed markets
    db
      .select({
        ticker: tips.ticker,
        sentiment: tips.sentiment,
        summary: tips.summary,
        targetPrice: tips.targetPrice,
        createdAt: tips.createdAt,
        market: tips.market,
      })
      .from(tips)
      .where(gte(tips.createdAt, since))
      .orderBy(desc(tips.createdAt))
      .limit(5),
  ]);

  // Slice top symbols/industries by market, take top 5 per market
  const topSymbolsTw = topSymbolsRaw.filter((r) => r.market === "TW").slice(0, 5);
  const topSymbolsUs = topSymbolsRaw.filter((r) => r.market === "US").slice(0, 5);
  const topIndustriesTw = topIndustriesRaw.filter((r) => r.market === "TW").slice(0, 3);
  const topIndustriesUs = topIndustriesRaw.filter((r) => r.market === "US").slice(0, 3);
  const topSymbols = [...topSymbolsTw, ...topSymbolsUs]; // legacy var for name lookup

  // Dedup the raw sentiment rows in JS: keep one sentiment per unique hash.
  // Same text → same AI classification → same sentiment, so first-seen wins.
  const seenKeys = new Set<string>();
  const uniqueSentiments: (typeof sentimentRows)[number][] = [];
  for (const r of sentimentRows) {
    if (seenKeys.has(r.key)) continue;
    seenKeys.add(r.key);
    uniqueSentiments.push(r);
  }
  const total = uniqueSentiments.length;

  if (total === 0) {
    await sendMessage({
      chat_id: chatId,
      text: [
        "📊 <b>情報總覽</b>",
        "",
        `近 ${WINDOW_DAYS} 天尚無情報。`,
        "",
        "轉傳訊息給本 bot，AI 會自動分類並記錄進資料庫。",
      ].join("\n"),
      parse_mode: "HTML",
    });
    return;
  }

  const bullish = uniqueSentiments.filter((r) => r.sentiment === "bullish").length;
  const bearish = uniqueSentiments.filter((r) => r.sentiment === "bearish").length;
  const neutral = uniqueSentiments.filter((r) => r.sentiment === "neutral").length;

  // Pre-fetch ticker names for top symbols (one IN query)
  const topSymbolsList = topSymbols.map((r) => r.symbol);
  const tickerNameMap = new Map<string, string>();
  if (topSymbolsList.length > 0) {
    const nameRows = await db
      .select({ symbol: tickers.symbol, name: tickers.name })
      .from(tickers)
      .where(inArray(tickers.symbol, topSymbolsList));
    for (const r of nameRows) tickerNameMap.set(r.symbol, r.name);
  }

  // Extend the ticker name map with any tickers from the 最新情報 section so
  // those lines can also show "CODE NAME"
  const recentTickers = recentTips
    .map((t) => t.ticker)
    .filter((s): s is string => !!s && !tickerNameMap.has(s));
  if (recentTickers.length > 0) {
    const recentNameRows = await db
      .select({ symbol: tickers.symbol, name: tickers.name })
      .from(tickers)
      .where(inArray(tickers.symbol, recentTickers));
    for (const r of recentNameRows) tickerNameMap.set(r.symbol, r.name);
  }

  const lines: string[] = [];
  lines.push(`📊 <b>情報總覽</b>（近 ${WINDOW_DAYS} 天，相同內容已去重）`);
  lines.push("");
  lines.push(`共 <b>${total}</b> 則獨立情報　📈 ${bullish}　📉 ${bearish}　➡️ ${neutral}`);

  // Helper to render a market section of top symbols
  const renderTopSymbols = (
    flag: string,
    title: string,
    rows: typeof topSymbolsRaw
  ) => {
    if (rows.length === 0) return;
    lines.push("");
    lines.push(`${flag} <b>${title}</b>`);
    rows.forEach((row, idx) => {
      const label = formatSymbolName(row.symbol, tickerNameMap.get(row.symbol));
      const sentimentParts: string[] = [];
      if (row.bullish > 0) sentimentParts.push(`📈${row.bullish}`);
      if (row.bearish > 0) sentimentParts.push(`📉${row.bearish}`);
      if (row.neutral > 0) sentimentParts.push(`➡️${row.neutral}`);
      const sentTail =
        sentimentParts.length > 0 ? ` ｜ ${sentimentParts.join(" ")}` : "";
      lines.push(`${idx + 1}. <b>${label}</b>　${row.total} 次${sentTail}`);
    });
  };

  renderTopSymbols("🇹🇼", "台股熱門", topSymbolsTw);
  renderTopSymbols("🇺🇸", "美股熱門", topSymbolsUs);

  // Top industries — paired sections
  const renderIndustries = (
    flag: string,
    title: string,
    rows: typeof topIndustriesRaw
  ) => {
    if (rows.length === 0) return;
    lines.push("");
    lines.push(`${flag} <b>${title}</b>`);
    for (const row of rows) {
      lines.push(`• ${row.industry} ${row.count} 筆`);
    }
  };

  renderIndustries("🏭", "台股熱門產業", topIndustriesTw);
  renderIndustries("🏭", "美股熱門產業", topIndustriesUs);

  // Recent tips (cross-market with flag)
  if (recentTips.length > 0) {
    lines.push("");
    lines.push("🆕 <b>最新情報</b>");
    for (const t of recentTips) {
      const icon =
        t.sentiment === "bullish" ? "📈" : t.sentiment === "bearish" ? "📉" : "➡️";
      const date = new Date(t.createdAt).toLocaleDateString("zh-TW", {
        month: "2-digit",
        day: "2-digit",
      });
      const flagPrefix = t.market === "US" ? "🇺🇸 " : t.market === "TW" ? "🇹🇼 " : "";
      const tkr = t.ticker
        ? ` <b>${formatSymbolName(t.ticker, tickerNameMap.get(t.ticker))}</b>`
        : "";
      const tgt = t.targetPrice
        ? ` 目標 ${parseFloat(t.targetPrice).toLocaleString()}`
        : "";
      const summary = t.summary ? `\n  ${t.summary}` : "";
      lines.push(`• ${date} ${flagPrefix}${tkr} ${icon}${tgt}${summary}`);
    }
  }

  lines.push("");
  lines.push("<i>用 /q 代號 查看個股詳細資料</i>");

  await sendMessage({
    chat_id: chatId,
    text: lines.join("\n"),
    parse_mode: "HTML",
  });
}

// ─── /q — stock query with live quote + tips ──────────────────────────────────

async function handleQuery(rawCommand: string, chatId: number): Promise<void> {
  const parts = rawCommand.trim().split(/\s+/);
  const rawSymbol = parts[1]?.toUpperCase() ?? "";

  if (!rawSymbol) {
    await sendMessage({
      chat_id: chatId,
      text: "❓ 用法：<code>/q 股票代號</code>\n例如：<code>/q 2330</code>",
      parse_mode: "HTML",
    });
    return;
  }

  const market = classifyMarket(rawSymbol);
  const twKind = classifyTwSymbol(rawSymbol);

  // Expand bare Taiwan 4-5 digit codes to .TW / .TWO variants for tip matching
  const variants: string[] = [rawSymbol];
  if (market === "TW" && twKind === "stock") {
    variants.push(`${rawSymbol}.TW`, `${rawSymbol}.TWO`);
  }

  // Parallel: resolve ticker, fetch quote, fetch tips, fetch market-specific data
  const quoteStart = new Date();
  quoteStart.setDate(quoteStart.getDate() - 5);
  const quoteStartDate = quoteStart.toISOString().slice(0, 10);

  const [ticker, quote, tipRows, instRows, insiderRows, recRows, usProfile] = await Promise.all([
    // TW stocks live in tickers; US tickers may be lazy-upserted
    market === "TW" && twKind === "stock"
      ? resolveTicker(rawSymbol)
      : market === "US"
      ? upsertUsTicker(rawSymbol)
      : Promise.resolve(null),
    // Quote: market-aware via lib/price/client
    market !== "unknown" ? fetchLatestQuote(rawSymbol) : Promise.resolve(null),
    // Tips for this symbol
    db
      .select({
        sentiment: tipTickers.sentiment,
        targetPrice: tipTickers.targetPrice,
        summary: tips.summary,
        confidence: tips.confidence,
        market: tips.market,
        createdAt: tips.createdAt,
        industryCategory: tips.industryCategory,
        companyDescription: tips.companyDescription,
        sectorPosition: tips.sectorPosition,
      })
      .from(tipTickers)
      .innerJoin(tips, eq(tipTickers.tipId, tips.id))
      .where(inArray(tipTickers.symbol, variants))
      .orderBy(desc(tips.createdAt))
      .limit(20),
    // TW institutional (法人)
    market === "TW" && twKind === "stock"
      ? fetchInstitutionalInvestors(rawSymbol, quoteStartDate)
      : Promise.resolve(null),
    // US insider transactions
    market === "US"
      ? fetchUsInsiderTransactions(rawSymbol, 5)
      : Promise.resolve(null),
    // US analyst recommendations
    market === "US" ? fetchUsRecommendations(rawSymbol) : Promise.resolve(null),
    // US company profile (for industry display)
    market === "US" ? fetchUsCompanyProfile(rawSymbol) : Promise.resolve(null),
  ]);

  // If nothing at all — no price, no tips, no ticker match — report not found
  if (!ticker && !quote && tipRows.length === 0) {
    await sendMessage({
      chat_id: chatId,
      text: [
        `❓ 找不到 <b>${rawSymbol}</b> 的任何資料。`,
        "",
        "可能原因：",
        "• 代號格式錯誤（台股 4-5 位數字、美股大寫字母）",
        "• 該股票未被納入系統資料源",
      ].join("\n"),
      parse_mode: "HTML",
    });
    return;
  }

  // ── Build header: symbol + name + industry/sector ──────────────────────────
  const displayName = ticker?.name ?? usProfile?.name ?? "";
  const industryCat =
    market === "US"
      ? usProfile?.industry ?? null
      : tipRows.find((r) => r.industryCategory)?.industryCategory ?? null;

  const flag = market === "US" ? "🇺🇸 " : market === "TW" ? "🇹🇼 " : "";
  const headerParts = [`📊 ${flag}<b>${rawSymbol}</b>`];
  if (displayName) headerParts.push(displayName);
  if (twKind === "warrant") headerParts.push("（權證）");
  const header = industryCat
    ? `${headerParts.join(" ")} ｜ ${industryCat}`
    : headerParts.join(" ");

  const lines: string[] = [header];

  // ── Live quote block ──────────────────────────────────────────────────────
  if (quote) {
    const dateLabel = quote.date.slice(5); // "MM-DD"
    const pctStr =
      quote.changePct !== null
        ? `${quote.changePct >= 0 ? "+" : ""}${quote.changePct.toFixed(2)}%`
        : "—";
    const absStr =
      quote.changeAbs !== null
        ? `${quote.changeAbs >= 0 ? "+" : ""}${quote.changeAbs.toFixed(2)}`
        : "";
    const arrow =
      quote.changePct === null
        ? ""
        : quote.changePct > 0
        ? "🔺"
        : quote.changePct < 0
        ? "🔻"
        : "▪️";

    lines.push("");
    lines.push(
      `${arrow} 現價 <b>${quote.close.toFixed(2)}</b>　${absStr ? absStr + "（" : ""}${pctStr}${absStr ? "）" : ""}`
    );
    if (market === "TW") {
      const volLots = Math.round(quote.volume / 1000);
      lines.push(
        `　高 ${quote.high.toFixed(2)}　低 ${quote.low.toFixed(2)}　量 ${volLots.toLocaleString()} 張`
      );
    } else {
      // US: Finnhub /quote doesn't include volume; show high/low only
      lines.push(`　高 ${quote.high.toFixed(2)}　低 ${quote.low.toFixed(2)}`);
    }
    lines.push(`　資料日 ${dateLabel}`);
  }

  // ── US: Insider trades block ──────────────────────────────────────────────
  if (insiderRows && insiderRows.length > 0) {
    lines.push("");
    lines.push(`<b>近期 Insider 異動（Form 4）</b>`);
    for (const t of insiderRows) {
      const dir = t.change > 0 ? "🟢 買" : "🔴 賣";
      const shareAbs = Math.abs(t.change).toLocaleString();
      const px = t.transactionPrice > 0 ? ` @${t.transactionPrice.toFixed(2)}` : "";
      lines.push(
        `　${t.transactionDate.slice(5)} ${dir} ${t.name} ${shareAbs} 股${px}`
      );
    }
  }

  // ── US: Analyst recommendations block (latest period) ─────────────────────
  if (recRows && recRows.length > 0) {
    const latest = recRows[0];
    if (latest) {
      const total =
        latest.strongBuy +
        latest.buy +
        latest.hold +
        latest.sell +
        latest.strongSell;
      lines.push("");
      lines.push(`<b>分析師評級</b>（${latest.period.slice(0, 7)}，${total} 家）`);
      const parts: string[] = [];
      if (latest.strongBuy > 0) parts.push(`強買 ${latest.strongBuy}`);
      if (latest.buy > 0) parts.push(`買 ${latest.buy}`);
      if (latest.hold > 0) parts.push(`持有 ${latest.hold}`);
      if (latest.sell > 0) parts.push(`賣 ${latest.sell}`);
      if (latest.strongSell > 0) parts.push(`強賣 ${latest.strongSell}`);
      lines.push(`　${parts.join("　")}`);
    }
  }

  // ── TW: Institutional block (latest trading day only) ─────────────────────
  if (instRows && instRows.length > 0) {
    // Group by date, take latest date
    const byDate = new Map<string, typeof instRows>();
    for (const r of instRows) {
      const arr = byDate.get(r.date) ?? [];
      arr.push(r);
      byDate.set(r.date, arr);
    }
    const latestDate = Array.from(byDate.keys()).sort().pop();
    if (latestDate) {
      const rows = byDate.get(latestDate)!;
      const netByGroup = {
        foreign: 0,  // Foreign_Investor + Foreign_Dealer_Self
        trust: 0,    // Investment_Trust
        dealer: 0,   // Dealer_self + Dealer_Hedging
      };
      for (const r of rows) {
        const net = Math.round((r.buy - r.sell) / 1000); // 張
        if (r.name === "Foreign_Investor" || r.name === "Foreign_Dealer_Self") {
          netByGroup.foreign += net;
        } else if (r.name === "Investment_Trust") {
          netByGroup.trust += net;
        } else {
          netByGroup.dealer += net;
        }
      }
      const fmt = (n: number) => (n >= 0 ? `+${n.toLocaleString()}` : n.toLocaleString());
      lines.push("");
      lines.push(
        `<b>三大法人</b>（${latestDate.slice(5)}，張）`
      );
      lines.push(
        `　外資 ${fmt(netByGroup.foreign)}　投信 ${fmt(netByGroup.trust)}　自營 ${fmt(netByGroup.dealer)}`
      );
    }
  }

  // ── Tips block ────────────────────────────────────────────────────────────
  if (tipRows.length > 0) {
    const total = tipRows.length;
    const bullish = tipRows.filter((r) => r.sentiment === "bullish").length;
    const bearish = tipRows.filter((r) => r.sentiment === "bearish").length;
    const neutral = tipRows.filter((r) => r.sentiment === "neutral").length;

    lines.push("");
    lines.push(`<b>本站情報（${total} 筆）</b>`);
    lines.push(`　📈 看多 ${bullish}　📉 看空 ${bearish}　➡️ 中性 ${neutral}`);

    const recentLines = tipRows.slice(0, 5).map((r) => {
      const icon =
        r.sentiment === "bullish" ? "📈" : r.sentiment === "bearish" ? "📉" : "➡️";
      const date = new Date(r.createdAt).toLocaleDateString("zh-TW", {
        month: "2-digit",
        day: "2-digit",
      });
      const target = r.targetPrice
        ? ` 目標 ${parseFloat(r.targetPrice).toLocaleString()}`
        : "";
      const summary = r.summary ? `\n  ${r.summary}` : "";
      return `• ${date} ${icon}${target}${summary}`;
    });

    lines.push("");
    lines.push("<b>最近情報：</b>");
    lines.push(...recentLines);

    if (total > 5) {
      lines.push("");
      lines.push(`⋯ 顯示最近 5 筆，共 ${total} 筆`);
    }

    // Pick a company description if any
    const desc = tipRows.find((r) => r.companyDescription)?.companyDescription;
    if (desc) {
      lines.push("");
      lines.push(`💼 ${desc}`);
    }
  } else if (ticker || quote) {
    lines.push("");
    lines.push("<i>本站目前沒有此股的情報記錄。</i>");
  }

  await sendMessage({
    chat_id: chatId,
    text: lines.join("\n"),
    parse_mode: "HTML",
  });
}

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
      text: [
        "❓ <b>用法</b>",
        "• 台股：<code>/buy 2330 10 985.5</code>（張數）",
        "• 美股：<code>/buy AAPL 5 178.5</code>（股數）",
      ].join("\n"),
      parse_mode: "HTML",
    });
    return;
  }

  const symbolUpper = rawSymbol.toUpperCase();
  const market = classifyMarket(symbolUpper);

  if (market === "unknown") {
    await sendMessage({
      chat_id: chatId,
      text: "❌ 代號格式錯誤。台股請用 4-5 位數字（<code>2330</code>、<code>00878</code>）；美股請用大寫字母（<code>AAPL</code>、<code>NVDA</code>）",
      parse_mode: "HTML",
    });
    return;
  }

  // For TW, also reject warrants explicitly
  if (market === "TW") {
    const kind = classifyTwSymbol(symbolUpper);
    if (kind === "warrant") {
      await sendMessage({
        chat_id: chatId,
        text: [
          "ℹ️ <b>本系統不追蹤權證</b>",
          "",
          "權證因到期日與高波動特性，不納入持倉管理。",
        ].join("\n"),
        parse_mode: "HTML",
      });
      return;
    }
  }

  const sharesLots = parseFloat(rawLots);
  const price = parseFloat(rawPrice);
  const unit = quantityUnit(market);

  if (!isFinite(sharesLots) || sharesLots <= 0) {
    await sendMessage({
      chat_id: chatId,
      text: `❌ ${unit}數必須大於 0`,
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

  // Resolve / lazy-upsert ticker
  let symbol: string;
  let displayName: string;
  if (market === "US") {
    const upserted = await upsertUsTicker(symbolUpper);
    symbol = upserted?.symbol ?? symbolUpper;
    displayName = upserted?.name ?? symbolUpper;
  } else {
    const ticker = await resolveTicker(symbolUpper);
    symbol = ticker?.symbol ?? `${symbolUpper}.TW`;
    displayName = ticker?.name ?? symbolUpper;
  }

  try {
    const result = await buyHolding({ userId, symbol, sharesLots, price });
    await sendMessage({
      chat_id: chatId,
      text: [
        `✅ 已記錄 買入 ${symbolUpper} ${displayName} ${sharesLots} ${unit} @${price.toFixed(2)}`,
        `持股更新為 ${result.sharesLots} ${unit}，均價 ${result.avgCost.toFixed(2)}`,
      ].join("\n"),
      parse_mode: "HTML",
    });

    // Alert prompt only for stocks (TW + US both supported)
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

  // No args → interactive menu mode (pick a holding, then qty)
  if (!rawSymbol) {
    await handleSellInteractiveList(userId, chatId);
    return;
  }

  // Symbol only (no lots / price) → also route to interactive for that symbol
  if (!rawLots || !rawPrice) {
    await sendMessage({
      chat_id: chatId,
      text: [
        "❓ 用法：",
        "• 互動模式：直接輸入 <code>/sell</code>（選持股 → 選張數）",
        "• 指令模式：<code>/sell 代號 張數 賣價</code>",
        "  例：<code>/sell 2330 5 1050</code>",
      ].join("\n"),
      parse_mode: "HTML",
    });
    return;
  }

  const symbolUpper = rawSymbol.toUpperCase();
  const market = classifyMarket(symbolUpper);
  if (market === "unknown") {
    await sendMessage({
      chat_id: chatId,
      text: "❌ 代號格式錯誤。台股 4-5 位數字（<code>2330</code>），美股大寫字母（<code>AAPL</code>）",
      parse_mode: "HTML",
    });
    return;
  }

  const sharesLots = parseFloat(rawLots);
  const price = parseFloat(rawPrice);
  const unit = quantityUnit(market);

  if (!isFinite(sharesLots) || sharesLots <= 0) {
    await sendMessage({
      chat_id: chatId,
      text: `❌ ${unit}數必須大於 0`,
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

  let symbol: string;
  let displayName: string;
  if (market === "US") {
    const upserted = await upsertUsTicker(symbolUpper);
    symbol = upserted?.symbol ?? symbolUpper;
    displayName = upserted?.name ?? symbolUpper;
  } else {
    const ticker = await resolveTicker(symbolUpper);
    symbol = ticker?.symbol ?? `${symbolUpper}.TW`;
    displayName = ticker?.name ?? symbolUpper;
  }

  try {
    // 先查均價（用於計算實現損益）
    const [existing] = await db
      .select({ avgCost: holdingsTable.avgCost })
      .from(holdingsTable)
      .where(and(eq(holdingsTable.userId, userId), eq(holdingsTable.symbol, symbol)))
      .limit(1);

    const avgCost = existing ? parseFloat(existing.avgCost) : null;

    const result = await sellHolding({ userId, symbol, sharesLots, price });

    // 計算實現損益（市場感知：TW 1 張 = 1000 股）
    const multiplier = sharesPerLot(market);
    let pnlText = "";
    if (avgCost !== null) {
      const realizedPnl = (price - avgCost) * sharesLots * multiplier;
      const pnlPct = avgCost > 0 ? ((price - avgCost) / avgCost) * 100 : 0;
      const sign = realizedPnl >= 0 ? "+" : "";
      pnlText = `\n實現損益：${formatMoney(realizedPnl, symbol, { withSign: true })}（${sign}${pnlPct.toFixed(1)}%）`;
    }

    const afterText = result === null
      ? "持股已全數賣出"
      : `剩餘 ${result.sharesLots} ${unit}，均價 ${result.avgCost.toFixed(2)}`;

    // When fully sold out, also remove any price alert — user no longer
    // holds it so the alert is noise. Partial sells keep the alert.
    let alertRemovedNote = "";
    if (result === null) {
      const removed = await db
        .delete(priceAlerts)
        .where(
          and(eq(priceAlerts.userId, userId), eq(priceAlerts.symbol, symbol))
        )
        .returning({ symbol: priceAlerts.symbol });
      if (removed.length > 0) {
        alertRemovedNote = `\n🔕 已同步移除此股警示`;
      }
    }

    await sendMessage({
      chat_id: chatId,
      text: [
        `✅ 已記錄 賣出 ${rawSymbol} ${displayName} ${sharesLots} ${unit} @${price.toFixed(2)}`,
        afterText + pnlText + alertRemovedNote,
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

async function handlePortfolio(
  userId: string,
  chatId: number,
  marketFilter: "tw" | "us" | "all" = "all"
): Promise<void> {
  try {
    const allRows = await listPortfolio(userId);

    const rows =
      marketFilter === "all"
        ? allRows
        : allRows.filter((r) =>
            marketFilter === "tw" ? r.market === "TW" : r.market === "US"
          );

    if (rows.length === 0) {
      const labelEmpty =
        marketFilter === "all"
          ? "你目前沒有持股，使用 /buy 開始記錄"
          : marketFilter === "tw"
          ? "目前沒有台股持倉"
          : "目前沒有美股持倉";
      await sendMessage({
        chat_id: chatId,
        text: `📭 ${labelEmpty}`,
        parse_mode: "HTML",
      });
      return;
    }

    const headerLabel =
      marketFilter === "all" ? "我的持股" :
      marketFilter === "tw" ? "我的持股 ｜ 🇹🇼 台股" : "我的持股 ｜ 🇺🇸 美股";

    const lines: string[] = [`📊 <b>${headerLabel}</b>`, ""];

    // For "all", group by market for cleaner display
    const groupedByMarket = marketFilter === "all"
      ? [
          { name: "🇹🇼 台股", subset: rows.filter((r) => r.market === "TW") },
          { name: "🇺🇸 美股", subset: rows.filter((r) => r.market === "US") },
        ].filter((g) => g.subset.length > 0)
      : [{ name: "", subset: rows }];

    // Track per-currency totals (TW pnl in NTD, US pnl in USD — don't mix)
    type Tally = { cost: number; value: number; allHavePrice: boolean };
    const totals: { TW: Tally; US: Tally } = {
      TW: { cost: 0, value: 0, allHavePrice: true },
      US: { cost: 0, value: 0, allHavePrice: true },
    };

    for (const group of groupedByMarket) {
      if (group.name) {
        lines.push(`<b>${group.name}</b>`);
      }
      group.subset.forEach((row, idx) => {
        const label = formatSymbolName(row.symbol, row.name);
        const unit = quantityUnit(row.market);
        const lotsStr = row.sharesLots % 1 === 0
          ? String(row.sharesLots)
          : row.sharesLots.toFixed(2);

        lines.push(
          `${idx + 1}. <b>${label}</b> ${lotsStr} ${unit} @${row.avgCost.toFixed(2)}`
        );

        if (
          row.currentPrice !== null &&
          row.marketValue !== null &&
          row.pnl !== null &&
          row.pnlPct !== null
        ) {
          const pnlSign = row.pnl >= 0 ? "+" : "";
          lines.push(
            `   現價 ${row.currentPrice.toFixed(2)}（${pnlSign}${row.pnlPct.toFixed(2)}%）`
          );
          lines.push(
            `   市值 ${formatMoney(row.marketValue, row.symbol)}（${formatMoney(row.pnl, row.symbol, { withSign: true })}）`
          );
          totals[row.market].value += row.marketValue;
        } else {
          lines.push("   現價 無法取得");
          totals[row.market].allHavePrice = false;
          totals[row.market].value += row.costBasis;
        }

        totals[row.market].cost += row.costBasis;
        lines.push("");
      });
    }

    lines.push("---");
    for (const m of ["TW", "US"] as Market[]) {
      const t = totals[m];
      if (t.cost === 0) continue;
      // Sample symbol for currency formatting: "2330" classifies as TW,
      // "AAPL" as US. (Don't use single letters — "X" matches the US regex.)
      const sampleSym = m === "TW" ? "2330" : "AAPL";
      const pnl = t.value - t.cost;
      const pnlPct = t.cost > 0 ? (pnl / t.cost) * 100 : 0;
      const sign = pnl >= 0 ? "+" : "";
      const flagged = m === "TW" ? "🇹🇼" : "🇺🇸";
      lines.push(`${flagged} 總成本：${formatMoney(t.cost, sampleSym)}`);
      if (t.allHavePrice) {
        lines.push(`${flagged} 總市值：${formatMoney(t.value, sampleSym)}`);
        lines.push(
          `${flagged} 未實現損益：${formatMoney(pnl, sampleSym, { withSign: true })}（${sign}${pnlPct.toFixed(2)}%）`
        );
      } else {
        lines.push(`${flagged} （部分持股無法取得即時行情）`);
      }
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

// ─── Holdings: /clear — one-click liquidation ────────────────────────────────

async function handleClearPrompt(userId: string, chatId: number): Promise<void> {
  const rows = await listPortfolio(userId);

  if (rows.length === 0) {
    await sendMessage({
      chat_id: chatId,
      text: "📭 你目前沒有任何持股",
      parse_mode: "HTML",
    });
    return;
  }

  const lines: string[] = [
    "⚠️ <b>一鍵清倉確認</b>",
    "",
    `你目前持有 <b>${rows.length}</b> 檔：`,
    "",
  ];

  let totalCost = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const label = formatSymbolName(r.symbol, r.name);
    const lotsStr = r.sharesLots % 1 === 0 ? String(r.sharesLots) : r.sharesLots.toFixed(1);
    lines.push(`${i + 1}. ${label} ${lotsStr} 張 @均價 ${r.avgCost.toFixed(2)}`);
    totalCost += r.costBasis;
  }

  lines.push("");
  lines.push(`總成本：NT$${totalCost.toLocaleString("zh-TW", { maximumFractionDigits: 0 })}`);
  lines.push("");
  lines.push("按下確認後，將以<b>執行當下的 FinMind 市價</b>全數賣出（含移除對應警示）。");

  await sendMessage({
    chat_id: chatId,
    text: lines.join("\n"),
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "✅ 確認全部清倉", callback_data: "clear:confirm" },
          { text: "❌ 取消", callback_data: "clear:cancel" },
        ],
      ],
    },
  });
}

async function handleClearCallback(
  query: TelegramCallbackQuery,
  data: string
): Promise<void> {
  const action = data.split(":")[1];

  // Strip buttons immediately to prevent double-tap
  if (query.message) {
    await editMessageReplyMarkup({
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
  }

  if (action === "cancel") {
    await answerCallbackQuery({
      callback_query_id: query.id,
      text: "已取消清倉",
    });
    await sendMessage({
      chat_id: query.from.id,
      text: "❌ <b>已取消清倉</b>",
      parse_mode: "HTML",
    });
    return;
  }

  // Shortcut from /sell interactive menu → show the confirm prompt instead
  if (action === "prompt") {
    const [profile] = await db
      .select({ id: userProfiles.id })
      .from(userProfiles)
      .where(eq(userProfiles.telegramId, query.from.id))
      .limit(1);
    if (!profile) {
      await answerCallbackQuery({ callback_query_id: query.id, text: "找不到帳號" });
      return;
    }
    await answerCallbackQuery({ callback_query_id: query.id });
    await handleClearPrompt(profile.id, query.from.id);
    return;
  }

  if (action !== "confirm") {
    await answerCallbackQuery({ callback_query_id: query.id });
    return;
  }

  // Resolve user
  const [profile] = await db
    .select({ id: userProfiles.id })
    .from(userProfiles)
    .where(eq(userProfiles.telegramId, query.from.id))
    .limit(1);

  if (!profile) {
    await answerCallbackQuery({
      callback_query_id: query.id,
      text: "找不到帳號",
      show_alert: true,
    });
    return;
  }

  const rows = await listPortfolio(profile.id);
  if (rows.length === 0) {
    await answerCallbackQuery({
      callback_query_id: query.id,
      text: "持倉已空",
    });
    await sendMessage({
      chat_id: query.from.id,
      text: "ℹ️ 持倉已經是空的，無需清倉。",
      parse_mode: "HTML",
    });
    return;
  }

  await answerCallbackQuery({
    callback_query_id: query.id,
    text: `🔄 正在清倉 ${rows.length} 檔…`,
  });

  type LiquidationResult =
    | { ok: true; symbol: string; name: string | null; lots: number; price: number; pnl: number }
    | { ok: false; symbol: string; name: string | null; reason: string };

  const results: LiquidationResult[] = [];

  for (const r of rows) {
    // Prefer the price listPortfolio already fetched; fall back to a live lookup
    const price = r.currentPrice ?? (await fetchCurrentPrice(r.symbol));
    if (!price) {
      results.push({ ok: false, symbol: r.symbol, name: r.name, reason: "取不到市價" });
      continue;
    }
    try {
      await sellHolding({
        userId: profile.id,
        symbol: r.symbol,
        sharesLots: r.sharesLots,
        price,
        note: "一鍵清倉",
      });
      // Remove any alert for this symbol (position is gone)
      await db
        .delete(priceAlerts)
        .where(
          and(
            eq(priceAlerts.userId, profile.id),
            eq(priceAlerts.symbol, r.symbol)
          )
        );
      const pnl = (price - r.avgCost) * r.sharesLots * 1000;
      results.push({
        ok: true,
        symbol: r.symbol,
        name: r.name,
        lots: r.sharesLots,
        price,
        pnl,
      });
    } catch (err) {
      console.error("[clear] sell failed:", err);
      results.push({
        ok: false,
        symbol: r.symbol,
        name: r.name,
        reason: err instanceof Error ? err.message : "未知錯誤",
      });
    }
  }

  const succeeded = results.filter((r): r is Extract<LiquidationResult, { ok: true }> => r.ok);
  const failed = results.filter((r): r is Extract<LiquidationResult, { ok: false }> => !r.ok);

  const totalPnl = succeeded.reduce((sum, r) => sum + r.pnl, 0);
  const pnlSign = totalPnl >= 0 ? "+" : "";

  const lines: string[] = [];
  lines.push(`✅ <b>清倉完成</b>（成功 ${succeeded.length} / 失敗 ${failed.length}）`);
  lines.push("");

  if (succeeded.length > 0) {
    for (const s of succeeded) {
      const label = formatSymbolName(s.symbol, s.name);
      const lotsStr = s.lots % 1 === 0 ? String(s.lots) : s.lots.toFixed(1);
      const pSign = s.pnl >= 0 ? "+" : "";
      lines.push(
        `• ${label} ${lotsStr} 張 @${s.price.toFixed(2)}　${pSign}NT$${Math.abs(Math.round(s.pnl)).toLocaleString()}`
      );
    }
    lines.push("");
    lines.push(
      `<b>實現總損益：${pnlSign}NT$${Math.abs(Math.round(totalPnl)).toLocaleString()}</b>`
    );
  }

  if (failed.length > 0) {
    lines.push("");
    lines.push("⚠️ <b>未賣出：</b>");
    for (const f of failed) {
      const label = formatSymbolName(f.symbol, f.name);
      lines.push(`• ${label} — ${f.reason}`);
    }
    lines.push("");
    lines.push("請用 <code>/sell 代號 張數 賣價</code> 手動處理上述標的。");
  }

  await sendMessage({
    chat_id: query.from.id,
    text: lines.join("\n"),
    parse_mode: "HTML",
  });
}

// ─── Holdings: interactive /sell flow ────────────────────────────────────────

const PENDING_SELL_TTL_MS = 5 * 60 * 1000; // 5 minutes

/** Show the list of holdings as inline-keyboard buttons, one per row. */
async function handleSellInteractiveList(
  userId: string,
  chatId: number
): Promise<void> {
  const rows = await listPortfolio(userId);

  if (rows.length === 0) {
    await sendMessage({
      chat_id: chatId,
      text: "📭 你目前沒有任何持股",
      parse_mode: "HTML",
    });
    return;
  }

  const keyboard: { text: string; callback_data: string }[][] = rows.map((r) => {
    const label = formatSymbolName(r.symbol, r.name);
    const lotsStr = r.sharesLots % 1 === 0 ? String(r.sharesLots) : r.sharesLots.toFixed(1);
    const priceTail = r.currentPrice !== null
      ? ` 現價 ${r.currentPrice.toFixed(2)}`
      : "";
    return [
      {
        text: `${label} ${lotsStr}張${priceTail}`,
        // callback_data must be ≤64 bytes; symbols are short so this is fine
        callback_data: `sell:${r.symbol}`,
      },
    ];
  });

  // Divider + "clear all" shortcut
  keyboard.push([{ text: "✖ 全部清倉 (/clear)", callback_data: "clear:prompt" }]);

  await sendMessage({
    chat_id: chatId,
    text: [
      "📊 <b>選擇要賣出的持股：</b>",
      "",
      "或用指令模式：<code>/sell 代號 張數 賣價</code>",
    ].join("\n"),
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard },
  });
}

/**
 * User tapped a holding button from the sell list.
 * Fetch current price, upsert a pending_sell row, then show the qty buttons.
 */
async function handleSellPickCallback(
  query: TelegramCallbackQuery,
  data: string
): Promise<void> {
  const symbol = data.slice("sell:".length);
  if (!symbol) {
    await answerCallbackQuery({ callback_query_id: query.id });
    return;
  }

  const [profile] = await db
    .select({ id: userProfiles.id })
    .from(userProfiles)
    .where(eq(userProfiles.telegramId, query.from.id))
    .limit(1);

  if (!profile) {
    await answerCallbackQuery({
      callback_query_id: query.id,
      text: "找不到帳號",
      show_alert: true,
    });
    return;
  }

  // Verify the user still holds this symbol, fetch lots + avg cost
  const [holding] = await db
    .select({
      sharesLots: holdingsTable.sharesLots,
      avgCost: holdingsTable.avgCost,
    })
    .from(holdingsTable)
    .where(and(eq(holdingsTable.userId, profile.id), eq(holdingsTable.symbol, symbol)))
    .limit(1);

  if (!holding) {
    await answerCallbackQuery({
      callback_query_id: query.id,
      text: "已無此持股",
      show_alert: true,
    });
    return;
  }

  const sharesLotsHeld = parseFloat(holding.sharesLots);
  const avgCost = parseFloat(holding.avgCost);

  // Strip buttons from the list message
  if (query.message) {
    await editMessageReplyMarkup({
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
  }

  const price = await fetchCurrentPrice(symbol);
  if (!price) {
    await answerCallbackQuery({
      callback_query_id: query.id,
      text: "取不到現價",
      show_alert: true,
    });
    await sendMessage({
      chat_id: query.from.id,
      text: `⚠️ 取不到 ${stripTwSuffix(symbol)} 的市價，請改用 <code>/sell 代號 張數 賣價</code> 指定賣價。`,
      parse_mode: "HTML",
    });
    return;
  }

  // Upsert pending_sell — only one active at a time per user
  await db
    .insert(pendingSells)
    .values({
      userId: profile.id,
      symbol,
      price: price.toString(),
    })
    .onConflictDoUpdate({
      target: pendingSells.userId,
      set: {
        symbol,
        price: price.toString(),
        createdAt: new Date(),
      },
    });

  await answerCallbackQuery({ callback_query_id: query.id });

  const ticker = await resolveTicker(symbol).catch(() => null);
  const label = formatSymbolName(symbol, ticker?.name);

  const pnlPct = avgCost > 0 ? ((price - avgCost) / avgCost) * 100 : 0;
  const sign = pnlPct >= 0 ? "+" : "";
  const halfLots = Math.max(
    1,
    Math.round(sharesLotsHeld / 2)
  );

  const lines = [
    `📊 <b>${label}</b>`,
    `持有 <b>${sharesLotsHeld % 1 === 0 ? sharesLotsHeld : sharesLotsHeld.toFixed(1)}</b> 張`,
    `均價 ${avgCost.toFixed(2)}　現價 ${price.toFixed(2)}（${sign}${pnlPct.toFixed(2)}%）`,
    "",
    "選擇賣出張數，或直接回覆數字（例如：3）",
    "",
    `<i>5 分鐘內有效</i>`,
  ];

  await sendMessage({
    chat_id: query.from.id,
    text: lines.join("\n"),
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: `全賣 ${sharesLotsHeld % 1 === 0 ? sharesLotsHeld : sharesLotsHeld.toFixed(1)} 張`,
            callback_data: `sellq:${symbol}:all`,
          },
        ],
        sharesLotsHeld > 1
          ? [
              {
                text: `一半 ${halfLots} 張`,
                callback_data: `sellq:${symbol}:half`,
              },
            ]
          : [],
        [{ text: "❌ 取消", callback_data: `sellq:${symbol}:cancel` }],
      ].filter((row) => row.length > 0),
    },
  });
}

/** User tapped a qty preset (all / half) or cancel. */
async function handleSellQtyCallback(
  query: TelegramCallbackQuery,
  data: string
): Promise<void> {
  // data = "sellq:{symbol}:{action}" — symbol may contain ".", so split from end
  const rest = data.slice("sellq:".length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon < 0) {
    await answerCallbackQuery({ callback_query_id: query.id });
    return;
  }
  const symbol = rest.slice(0, lastColon);
  const action = rest.slice(lastColon + 1);

  const [profile] = await db
    .select({ id: userProfiles.id })
    .from(userProfiles)
    .where(eq(userProfiles.telegramId, query.from.id))
    .limit(1);

  if (!profile) {
    await answerCallbackQuery({ callback_query_id: query.id, text: "找不到帳號" });
    return;
  }

  // Always strip buttons first
  if (query.message) {
    await editMessageReplyMarkup({
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
  }

  if (action === "cancel") {
    await db.delete(pendingSells).where(eq(pendingSells.userId, profile.id));
    await answerCallbackQuery({ callback_query_id: query.id, text: "已取消" });
    await sendMessage({
      chat_id: query.from.id,
      text: "❌ 已取消賣出",
      parse_mode: "HTML",
    });
    return;
  }

  // Fetch pending_sell (TTL check)
  const [pending] = await db
    .select()
    .from(pendingSells)
    .where(eq(pendingSells.userId, profile.id))
    .limit(1);

  if (!pending || pending.symbol !== symbol) {
    await answerCallbackQuery({
      callback_query_id: query.id,
      text: "此操作已失效，請重新 /sell",
      show_alert: true,
    });
    return;
  }

  const age = Date.now() - new Date(pending.createdAt).getTime();
  if (age > PENDING_SELL_TTL_MS) {
    await db.delete(pendingSells).where(eq(pendingSells.userId, profile.id));
    await answerCallbackQuery({
      callback_query_id: query.id,
      text: "操作已逾時（5 分鐘），請重新 /sell",
      show_alert: true,
    });
    return;
  }

  // Determine qty
  const [holding] = await db
    .select({ sharesLots: holdingsTable.sharesLots })
    .from(holdingsTable)
    .where(and(eq(holdingsTable.userId, profile.id), eq(holdingsTable.symbol, symbol)))
    .limit(1);

  if (!holding) {
    await db.delete(pendingSells).where(eq(pendingSells.userId, profile.id));
    await answerCallbackQuery({
      callback_query_id: query.id,
      text: "已無此持股",
    });
    return;
  }

  const heldLots = parseFloat(holding.sharesLots);
  let qty: number;
  if (action === "all") qty = heldLots;
  else if (action === "half") qty = Math.max(1, Math.round(heldLots / 2));
  else {
    await answerCallbackQuery({ callback_query_id: query.id });
    return;
  }

  await answerCallbackQuery({ callback_query_id: query.id });

  await executePendingSell(profile.id, query.from.id, symbol, qty, parseFloat(pending.price));
}

/**
 * Text-message handler: if the user has an active pending_sell and sent a pure
 * numeric message, treat it as the sell quantity. Returns true if handled.
 */
async function tryConsumePendingSellFromText(
  profileId: string,
  chatId: number,
  text: string
): Promise<boolean> {
  // Only plain numbers (allow decimal for fractional lots)
  if (!/^\d+(\.\d+)?$/.test(text.trim())) return false;

  const [pending] = await db
    .select()
    .from(pendingSells)
    .where(eq(pendingSells.userId, profileId))
    .limit(1);

  if (!pending) return false;

  const age = Date.now() - new Date(pending.createdAt).getTime();
  if (age > PENDING_SELL_TTL_MS) {
    await db.delete(pendingSells).where(eq(pendingSells.userId, profileId));
    return false;
  }

  const qty = parseFloat(text.trim());
  if (!isFinite(qty) || qty <= 0) return false;

  await executePendingSell(profileId, chatId, pending.symbol, qty, parseFloat(pending.price));
  return true;
}

/** Shared sell executor for both button-preset and numeric-text paths. */
async function executePendingSell(
  profileId: string,
  chatId: number,
  symbol: string,
  qty: number,
  price: number
): Promise<void> {
  // Clear pending regardless of outcome to avoid double-execution
  await db.delete(pendingSells).where(eq(pendingSells.userId, profileId));

  // Look up avg cost for PnL calc + ticker name for display
  const [existing] = await db
    .select({ avgCost: holdingsTable.avgCost })
    .from(holdingsTable)
    .where(and(eq(holdingsTable.userId, profileId), eq(holdingsTable.symbol, symbol)))
    .limit(1);
  const avgCost = existing ? parseFloat(existing.avgCost) : null;
  const ticker = await resolveTicker(symbol).catch(() => null);
  const label = formatSymbolName(symbol, ticker?.name);

  try {
    const result = await sellHolding({
      userId: profileId,
      symbol,
      sharesLots: qty,
      price,
      note: "互動賣出",
    });

    let pnlText = "";
    if (avgCost !== null) {
      const realizedPnl = (price - avgCost) * qty * 1000;
      const pnlPct = avgCost > 0 ? ((price - avgCost) / avgCost) * 100 : 0;
      const sign = realizedPnl >= 0 ? "+" : "";
      pnlText = `\n實現損益：${sign}NT$${Math.abs(Math.round(realizedPnl)).toLocaleString()}（${sign}${pnlPct.toFixed(1)}%）`;
    }

    const afterText = result === null
      ? "持股已全數賣出"
      : `剩餘 ${result.sharesLots} 張，均價 ${result.avgCost.toFixed(2)}`;

    let alertRemovedNote = "";
    if (result === null) {
      const removed = await db
        .delete(priceAlerts)
        .where(and(eq(priceAlerts.userId, profileId), eq(priceAlerts.symbol, symbol)))
        .returning({ symbol: priceAlerts.symbol });
      if (removed.length > 0) alertRemovedNote = "\n🔕 已同步移除此股警示";
    }

    await sendMessage({
      chat_id: chatId,
      text: [
        `✅ 已賣出 ${label} ${qty} 張 @${price.toFixed(2)}`,
        afterText + pnlText + alertRemovedNote,
      ].join("\n"),
      parse_mode: "HTML",
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : "";
    if (m.startsWith("INSUFFICIENT:")) {
      const current = m.split(":")[2] ?? "0";
      await sendMessage({
        chat_id: chatId,
        text: `❌ 持有不足，${label} 目前只有 ${current} 張`,
        parse_mode: "HTML",
      });
    } else if (m.startsWith("NO_HOLDING:")) {
      await sendMessage({
        chat_id: chatId,
        text: `❌ 你沒有持有 ${label}`,
        parse_mode: "HTML",
      });
    } else {
      console.error("[executePendingSell] error:", err);
      await sendMessage({
        chat_id: chatId,
        text: "⚠️ 賣出失敗，請稍後再試。",
        parse_mode: "HTML",
      });
    }
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
  name?: string | null;
  upPct: string | null;
  downPct: string | null;
  volumeMultiplier: string | null;
}): string {
  const parts: string[] = [];
  if (row.upPct !== null) parts.push(`漲 ≥ ${parseFloat(row.upPct).toFixed(1)}%`);
  if (row.downPct !== null) parts.push(`跌 ≤ ${parseFloat(row.downPct).toFixed(1)}%`);
  if (row.volumeMultiplier !== null) parts.push(`量 × ${parseFloat(row.volumeMultiplier).toFixed(1)}`);
  return `${formatSymbolName(row.symbol, row.name)} ｜ ${parts.join("  ")}`;
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
  const market = classifyMarket(rawSymbol);
  if (market === "unknown") {
    await sendMessage({
      chat_id: chatId,
      text: "❌ 代號格式錯誤。台股 4-5 位數字（<code>2330</code>），美股大寫字母（<code>AAPL</code>）",
      parse_mode: "HTML",
    });
    return;
  }
  if (market === "TW") {
    const kind = classifyTwSymbol(rawSymbol);
    if (kind === "warrant") {
      await sendMessage({
        chat_id: chatId,
        text: [
          "⚠️ <b>權證不支援盤中警示</b>",
          "",
          "權證單日波動可能達數十 %，固定 % 門檻容易持續誤觸發。",
          "如需追價請自行於券商 APP 設定。",
        ].join("\n"),
        parse_mode: "HTML",
      });
      return;
    }
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

  // Resolve symbol — market-aware
  const ticker =
    market === "US"
      ? await upsertUsTicker(rawSymbol)
      : await resolveTicker(rawSymbol);
  if (!ticker) {
    await sendMessage({
      chat_id: chatId,
      text: `❌ 找不到代號 <code>${rawSymbol}</code>，請確認代號正確。`,
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
      `<b>標的：</b>${formatSymbolName(ticker.symbol, ticker.name)}`,
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
      name: tickers.name,
      upPct: priceAlerts.upPct,
      downPct: priceAlerts.downPct,
      volumeMultiplier: priceAlerts.volumeMultiplier,
      enabled: priceAlerts.enabled,
    })
    .from(priceAlerts)
    .leftJoin(tickers, eq(tickers.symbol, priceAlerts.symbol))
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

  const bareTarget = stripTwSuffix(targetSymbol);
  if (deleted.length === 0) {
    await sendMessage({
      chat_id: chatId,
      text: `ℹ️ 找不到 <code>${bareTarget}</code> 的警示設定（可能已被移除或從未設定）。`,
      parse_mode: "HTML",
    });
    return;
  }

  const removedLabel = formatSymbolName(targetSymbol, ticker?.name);
  await sendMessage({
    chat_id: chatId,
    text: `✅ 已移除 <code>${removedLabel}</code> 的盤中警示。`,
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
  const label = formatSymbolName(symbol, displayName);
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
    const bareSkip = stripTwSuffix(symbol);
    await sendMessage({
      chat_id: query.from.id,
      text: `⏭ <b>${bareSkip}</b> 未設定警示。日後可用 <code>/alert ${bareSkip} +漲% -跌%</code> 自訂。`,
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

  const tickerRow = await resolveTicker(symbol).catch(() => null);
  const setLabel = formatSymbolName(symbol, tickerRow?.name);
  const bareSet = stripTwSuffix(symbol);

  await answerCallbackQuery({
    callback_query_id: query.id,
    text: `✅ 已設定 ${bareSet} ±${pct}% 警示`,
  });

  await sendMessage({
    chat_id: query.from.id,
    text: [
      `🔔 <b>${setLabel} 警示已設定</b>`,
      `漲 ≥ ${upPct}% 或跌 ≤ ${downPct}% 會通知你`,
      "",
      `想改門檻：<code>/alert ${bareSet} +X -Y</code>`,
      `關閉：<code>/unalert ${bareSet}</code>`,
    ].join("\n"),
    parse_mode: "HTML",
  });
}

// ─── Holdings: photo import ───────────────────────────────────────────────────

async function handleImportPhoto(
  userId: string,
  chatId: number,
  photos: NonNullable<TelegramMessage["photo"]>,
  market: Market
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

  const parsed = await parseHoldingsPhoto(base64, market);

  if (!parsed || (parsed.items.length === 0 && parsed.skippedWarrants.length === 0)) {
    await sendMessage({
      chat_id: chatId,
      text: [
        "❌ <b>截圖中未找到可匯入的持股</b>",
        "",
        "可能原因：",
        "• 截圖模糊或不是持股明細頁",
        "• 畫面全為期貨、基金等不支援的標的",
        "",
        "💡 <b>可改用文字批次匯入：</b>",
        "<pre>/import",
        "2330 10 985.5",
        "1711 2 35</pre>",
      ].join("\n"),
      parse_mode: "HTML",
    });
    return;
  }

  if (parsed.items.length === 0 && parsed.skippedWarrants.length > 0) {
    await sendMessage({
      chat_id: chatId,
      text: [
        "ℹ️ <b>截圖中只有權證，沒有可匯入的股票</b>",
        "",
        `已識別但略過的權證：<code>${parsed.skippedWarrants.slice(0, 10).join(", ")}</code>`,
        "",
        "本系統目前只追蹤一般股票與 ETF。",
      ].join("\n"),
      parse_mode: "HTML",
    });
    return;
  }

  await createImportPreview(
    userId,
    chatId,
    parsed.items,
    "screenshot",
    [],
    parsed.skippedWarrants,
    market
  );
}

// ─── Holdings: text-based /import ─────────────────────────────────────────────

/**
 * Parse multi-line text after `/import`. Each non-empty, non-comment line should
 * be `symbol lots price` (separated by whitespace, comma, or tab). Returns
 * valid items plus the raw lines that failed to parse (for user feedback).
 */
function parseImportTextLines(
  lines: string[],
  market: Market
): {
  items: ParsedHoldingItem[];
  invalid: string[];
  skippedWarrants: string[];
} {
  const items: ParsedHoldingItem[] = [];
  const invalid: string[] = [];
  const skippedWarrants: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#") || line.startsWith("//")) continue;

    const parts = line.split(/[\s,\t]+/).filter(Boolean);
    if (parts.length < 3) {
      invalid.push(line);
      continue;
    }

    const [symbolRaw, lotsRaw, priceRaw] = parts;
    const symbol = symbolRaw!.toUpperCase();
    const detectedMarket = classifyMarket(symbol);

    // Reject symbols from the wrong market — prevents typos cross-contaminating
    if (detectedMarket !== market) {
      invalid.push(line);
      continue;
    }

    if (market === "TW") {
      const kind = classifyTwSymbol(symbol);
      if (kind === "warrant") {
        skippedWarrants.push(symbol);
        continue;
      }
      if (kind !== "stock") {
        invalid.push(line);
        continue;
      }
    }
    // For US, classifyMarket === "US" already validates the format

    const sharesLots = parseFloat(lotsRaw!);
    const price = parseFloat(priceRaw!);

    if (!isFinite(sharesLots) || sharesLots <= 0 || !isFinite(price) || price <= 0) {
      invalid.push(line);
      continue;
    }

    items.push({ symbol, sharesLots, avgCost: price });
  }

  return { items, invalid, skippedWarrants };
}

async function handleImportText(
  userId: string,
  chatId: number,
  lines: string[],
  market: Market
): Promise<void> {
  const { items, invalid, skippedWarrants } = parseImportTextLines(lines, market);
  const unit = quantityUnit(market);

  if (items.length === 0) {
    const warrantNote =
      skippedWarrants.length > 0
        ? `\n\n⚠️ 已略過 ${skippedWarrants.length} 檔權證（${skippedWarrants.slice(0, 5).join(", ")}）：本系統不追蹤權證。`
        : "";
    const example =
      market === "TW"
        ? "<pre>/import tw\n2330 10 985.5\n1711 2 35</pre>"
        : "<pre>/import us\nAAPL 5 178\nNVDA 3 850</pre>";
    await sendMessage({
      chat_id: chatId,
      text: [
        "❌ <b>沒有可匯入的項目</b>",
        "",
        invalid.length > 0
          ? `無法解析的行（共 ${invalid.length} 行）：\n<code>${escapeHtml(invalid.slice(0, 5).join("\n"))}</code>`
          : `請確認每行格式為 <code>代號 ${unit}數 成本</code>`,
        "",
        "<b>範例：</b>",
        example,
      ].join("\n") + warrantNote,
      parse_mode: "HTML",
    });
    return;
  }

  await createImportPreview(userId, chatId, items, "text", invalid, skippedWarrants, market);
}

// ─── Import market selector callback ────────────────────────────────────────

async function handleImportMarketCallback(
  query: TelegramCallbackQuery,
  data: string
): Promise<void> {
  const arg = data.slice("imp:".length);
  if (arg !== "tw" && arg !== "us") {
    await answerCallbackQuery({ callback_query_id: query.id });
    return;
  }
  await answerCallbackQuery({ callback_query_id: query.id });
  if (query.message) {
    await editMessageReplyMarkup({
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
  }

  const flag = arg === "tw" ? "🇹🇼 台股" : "🇺🇸 美股";
  const example =
    arg === "tw"
      ? "<pre>/import tw\n2330 10 985.5\n1711 2 35</pre>"
      : "<pre>/import us\nAAPL 5 178\nNVDA 3 850</pre>";

  await sendMessage({
    chat_id: query.from.id,
    text: [
      `📥 <b>${flag} 匯入</b>`,
      "",
      "現在請傳：",
      `• 持股截圖 + caption 寫 <code>/import ${arg}</code>`,
      `• 或文字（第一行 <code>/import ${arg}</code>，後續每行 <code>代號 ${arg === "tw" ? "張數" : "股數"} 成本</code>）`,
      "",
      "範例：",
      example,
    ].join("\n"),
    parse_mode: "HTML",
  });
}

// ─── Holdings: shared preview + pending_imports writer ───────────────────────

/**
 * Shared preview flow for photo and text import. Caps items at 50, writes
 * pending_imports (replacing any prior), and sends the confirm/cancel buttons.
 */
async function createImportPreview(
  userId: string,
  chatId: number,
  rawItems: ParsedHoldingItem[],
  source: "screenshot" | "text",
  invalid: string[] = [],
  skippedWarrants: string[] = [],
  market: Market = "TW"
): Promise<void> {
  // Hard cap: AI hallucination / copy-paste defence. 50 items covers any real portfolio.
  const items = rawItems.slice(0, 50);
  const unit = quantityUnit(market);

  // Remove any prior pending imports from this user — only one active at a time
  await db.delete(pendingImports).where(eq(pendingImports.userId, userId));

  // Stuff market into the payload so confirm can route correctly.
  // Backward-compat: bare array still parses as TW (default).
  const [pending] = await db
    .insert(pendingImports)
    .values({
      userId,
      payload: { market, items } as unknown as typeof pendingImports.$inferInsert["payload"],
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

  const previewLines = items.map((item, idx) => {
    const lotsStr = item.sharesLots % 1 === 0
      ? String(item.sharesLots)
      : item.sharesLots.toFixed(2);
    return `${idx + 1}. ${item.symbol}　${lotsStr} ${unit}　@${item.avgCost.toFixed(2)}`;
  });

  const flag = market === "US" ? "🇺🇸 " : "🇹🇼 ";
  const header =
    source === "screenshot"
      ? `📋 <b>${flag}從截圖辨識到以下持股，請確認是否匯入：</b>`
      : `📋 <b>${flag}從文字解析到以下持股，請確認是否匯入：</b>`;

  const bodyLines: string[] = [header, "", ...previewLines];
  if (skippedWarrants.length > 0) {
    bodyLines.push("");
    bodyLines.push(
      `⚠️ 已略過 ${skippedWarrants.length} 檔權證（${skippedWarrants.slice(0, 3).join(", ")}${skippedWarrants.length > 3 ? "…" : ""}）：本系統不追蹤權證`
    );
  }
  if (invalid.length > 0) {
    bodyLines.push("");
    bodyLines.push(`⚠️ 已略過 ${invalid.length} 行無法解析的輸入`);
  }
  bodyLines.push("");
  bodyLines.push("請按下方按鈕確認或取消。");

  await sendMessage({
    chat_id: chatId,
    text: bodyLines.join("\n"),
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

  // ── Clear (/clear): "clear:confirm" or "clear:cancel" ────────────────────
  if (data.startsWith("clear:")) {
    await handleClearCallback(query, data);
    return;
  }

  // ── /portfolio market selector: "pf:tw" / "pf:us" / "pf:all" ─────────────
  if (data.startsWith("pf:")) {
    const arg = data.slice(3);
    if (arg !== "tw" && arg !== "us" && arg !== "all") {
      await answerCallbackQuery({ callback_query_id: query.id });
      return;
    }
    const [profile] = await db
      .select({ id: userProfiles.id })
      .from(userProfiles)
      .where(eq(userProfiles.telegramId, query.from.id))
      .limit(1);
    if (!profile) {
      await answerCallbackQuery({ callback_query_id: query.id, text: "找不到帳號" });
      return;
    }
    await answerCallbackQuery({ callback_query_id: query.id });
    if (query.message) {
      await editMessageReplyMarkup({
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        reply_markup: { inline_keyboard: [] },
      }).catch(() => {});
    }
    await handlePortfolio(profile.id, query.from.id, arg);
    return;
  }

  // ── /import market selector: "imp:tw" / "imp:us" ─────────────────────────
  if (data.startsWith("imp:")) {
    await handleImportMarketCallback(query, data);
    return;
  }

  // ── Interactive sell: "sell:{symbol}" (pick) or "sellq:{symbol}:{action}" ─
  if (data.startsWith("sell:")) {
    await handleSellPickCallback(query, data);
    return;
  }
  if (data.startsWith("sellq:")) {
    await handleSellQtyCallback(query, data);
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
  // Payload may be either {market, items} (new) or PendingImportItem[] (legacy)
  const rawPayload = pending.payload as
    | PendingImportItem[]
    | { market: Market; items: PendingImportItem[] };
  const items: PendingImportItem[] = Array.isArray(rawPayload)
    ? rawPayload
    : rawPayload.items;
  const payloadMarket: Market = Array.isArray(rawPayload)
    ? "TW"
    : rawPayload.market;

  // Pre-resolve all symbols. For TW go through tickers DB; for US use
  // upsertUsTicker (lazy Finnhub fetch).
  type ResolvedItem = {
    symbol: string;
    sharesLots: number;
    avgCost: number;
    rawSymbol: string;
  };
  const resolved: ResolvedItem[] = [];
  const unresolved: string[] = [];
  for (const item of items) {
    if (payloadMarket === "US") {
      const t = await upsertUsTicker(item.symbol);
      if (!t) {
        unresolved.push(item.symbol);
        continue;
      }
      resolved.push({
        symbol: t.symbol,
        sharesLots: item.sharesLots,
        avgCost: item.avgCost,
        rawSymbol: item.symbol,
      });
    } else {
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
        `以下代號無法對應：<code>${unresolved.join(", ")}</code>`,
        "",
        "請確認代號格式：股票 4-5 位數、權證 6 字元。",
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

  // ── Alert setup prompts — one inline-keyboard per newly imported stock ──
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
