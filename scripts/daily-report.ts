#!/usr/bin/env bun
/**
 * T4 — Daily Closing Report
 *
 * Runs every weekday at 19:00 TST (11:00 UTC) via GitHub Actions.
 * For each user who has active holdings and a linked Telegram ID,
 * sends a single HTML message summarising:
 *   - Today's open / close / daily change for each position
 *   - Institutional investor net buy/sell (三大法人, in 張)
 *   - Total portfolio market value, daily P&L, and unrealised P&L
 *
 * Non-trading day guard: if the first OHLCV fetch returns no data for
 * today's date, the whole run is skipped — no messages are sent.
 *
 * Rate-limit discipline:
 *   - 300 ms between every FinMind API call
 *   - 500 ms between sending each user's Telegram message
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, sql as drizzleSql } from "drizzle-orm";

import { holdings } from "@/lib/db/schema/holdings";
import { userProfiles } from "@/lib/db/schema/users";
import { tips } from "@/lib/db/schema/tips";

import {
  fetchDailyOHLCV,
  fetchInstitutionalInvestors,
  fetchWatchList,
} from "@/lib/finmind/client";
import { detectInstitutionalAnomaly } from "@/lib/chip-analysis/detector";
import { sendMessage } from "@/lib/telegram/client";

// ─── Config ───────────────────────────────────────────────────────────────────

const FINMIND_SLEEP_MS = 300;
const TELEGRAM_SLEEP_MS = 500;

// ─── DB setup ─────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env["DATABASE_URL"];
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not set");
  process.exit(1);
}

const pg = postgres(DATABASE_URL, { max: 3, prepare: false });
const db = drizzle(pg);

// ─── Types ────────────────────────────────────────────────────────────────────

interface OhlcvRow {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

interface PortfolioRow {
  symbol: string;       // e.g. "2330.TW"
  sharesLots: number;   // 張
  avgCost: number;      // per-share cost
}

interface EnrichedRow extends PortfolioRow {
  stockId: string;        // stripped, e.g. "2330"
  industryCategory: string | null;
  todayOhlcv: OhlcvRow | null;
  prevClose: number | null;
  dailyChangePct: number | null;
  currentPrice: number | null;
  marketValue: number | null;
  costBasis: number;
  pnl: number | null;
  pnlPct: number | null;
  institutionalForeign: number;    // 外資 net 張
  institutionalTrust: number;      // 投信 net 張
  institutionalDealer: number;     // 自營商 net 張
  // ── Chip anomaly flags (merged from T5) ────────────────────────────────
  watchListReason: string | null;  // 注意股/處置股原因，null = 未列管
  instAnomaly: { direction: "buy" | "sell"; todayLots: number; avgLots: number; multiplier: number } | null;
}

interface WatchListEntry {
  stockId: string;
  stockName: string;
  reason: string;
  date: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripSuffix(symbol: string): string {
  return symbol.replace(/\.(TW|TWO)$/i, "");
}

/** Format today as "YYYY-MM-DD" in Taiwan local time (UTC+8). */
function todayTaipei(): string {
  const now = new Date();
  // Offset to UTC+8
  const taipei = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return taipei.toISOString().slice(0, 10);
}

/** Format yesterday as "YYYY-MM-DD" in Taiwan local time (UTC+8). */
function yesterdayTaipei(): string {
  const now = new Date();
  const taipei = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  taipei.setDate(taipei.getDate() - 1);
  return taipei.toISOString().slice(0, 10);
}

function fmtNum(n: number): string {
  return n.toLocaleString("zh-TW");
}

function fmtSign(n: number, decimals = 0): string {
  const prefix = n >= 0 ? "+" : "";
  return `${prefix}${n.toFixed(decimals)}`;
}

function weekdayLabel(dateStr: string): string {
  const days = ["日", "一", "二", "三", "四", "五", "六"];
  const d = new Date(dateStr + "T00:00:00+08:00");
  const idx = d.getDay();
  return `週${days[idx] ?? "?"}`;
}

// ─── DB queries ───────────────────────────────────────────────────────────────

/** Returns unique user IDs that have at least one holding. */
async function fetchUsersWithHoldings(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: holdings.userId })
    .from(holdings);
  return rows.map((r) => r.userId);
}

/** Returns telegramId for a user, or null if not set. */
async function fetchTelegramId(userId: string): Promise<number | null> {
  const [row] = await db
    .select({ telegramId: userProfiles.telegramId })
    .from(userProfiles)
    .where(eq(userProfiles.id, userId))
    .limit(1);
  return row?.telegramId ?? null;
}

/** Returns all holdings for a user. */
async function fetchHoldings(userId: string): Promise<PortfolioRow[]> {
  const rows = await db
    .select({
      symbol: holdings.symbol,
      sharesLots: holdings.sharesLots,
      avgCost: holdings.avgCost,
    })
    .from(holdings)
    .where(eq(holdings.userId, userId));

  return rows.map((r) => ({
    symbol: r.symbol,
    sharesLots: parseFloat(r.sharesLots),
    avgCost: parseFloat(r.avgCost),
  }));
}

/**
 * Looks up the most recent classified tip for `stockId` (stripped)
 * and returns its industry_category, or null if none found.
 */
async function fetchIndustry(stockId: string): Promise<string | null> {
  // Tips store ticker without suffix (e.g. "2330"), and holdings store "2330.TW"
  // We match on stripped stockId
  const rows = await db
    .select({ industryCategory: tips.industryCategory })
    .from(tips)
    .where(
      drizzleSql`${tips.ticker} = ${stockId} AND ${tips.industryCategory} IS NOT NULL`
    )
    .orderBy(drizzleSql`${tips.createdAt} DESC`)
    .limit(1);

  return rows[0]?.industryCategory ?? null;
}

// ─── Core per-stock enrichment ────────────────────────────────────────────────

/**
 * Fetches OHLCV (from yesterday so we have prev close) and institutional data.
 * `todayStr` is "YYYY-MM-DD" in Taipei time.
 * Returns the enriched row.
 */
async function enrichHolding(
  row: PortfolioRow,
  todayStr: string,
  watchList: WatchListEntry[]
): Promise<EnrichedRow> {
  const stockId = stripSuffix(row.symbol);
  const costBasis = row.sharesLots * 1000 * row.avgCost;

  // Fetch OHLCV from yesterday to get both prev close and today's data
  const prevDay = yesterdayTaipei();
  const ohlcvRows = await fetchDailyOHLCV(stockId, prevDay);
  await sleep(FINMIND_SLEEP_MS);

  // Find today's row and the previous row
  let todayOhlcv: OhlcvRow | null = null;
  let prevClose: number | null = null;

  if (ohlcvRows && ohlcvRows.length > 0) {
    // Sort ascending by date (FinMind usually returns ascending, but be safe)
    const sorted = [...ohlcvRows].sort((a, b) => a.date.localeCompare(b.date));
    const todayIdx = sorted.findIndex((r) => r.date === todayStr);

    if (todayIdx >= 0) {
      todayOhlcv = sorted[todayIdx] ?? null;
      // Previous record in the returned window (could be yesterday or earlier)
      if (todayIdx > 0) {
        prevClose = sorted[todayIdx - 1]?.close ?? null;
      }
    }
  }

  const currentPrice = todayOhlcv?.close ?? null;
  let marketValue: number | null = null;
  let pnl: number | null = null;
  let pnlPct: number | null = null;

  if (currentPrice !== null) {
    marketValue = row.sharesLots * 1000 * currentPrice;
    pnl = marketValue - costBasis;
    pnlPct = costBasis > 0 ? (pnl / costBasis) * 100 : null;
  }

  let dailyChangePct: number | null = null;
  if (currentPrice !== null && prevClose !== null && prevClose > 0) {
    dailyChangePct = ((currentPrice - prevClose) / prevClose) * 100;
  }

  // Fetch institutional investors for the past ~30 days so we have both today
  // (for display) and a 20-day baseline (for anomaly detection).
  const instStart = new Date();
  instStart.setDate(instStart.getDate() - 30);
  const instStartStr = instStart.toISOString().slice(0, 10);
  const instData = await fetchInstitutionalInvestors(stockId, instStartStr);
  await sleep(FINMIND_SLEEP_MS);

  // Aggregate institutional flow per day (shares, not 張)
  const byDate = new Map<string, { foreign: number; trust: number; dealer: number }>();
  for (const r of instData ?? []) {
    const entry = byDate.get(r.date) ?? { foreign: 0, trust: 0, dealer: 0 };
    const net = r.buy - r.sell;
    if (r.name === "Foreign_Investor" || r.name === "Foreign_Dealer_Self") {
      entry.foreign += net;
    } else if (r.name === "Investment_Trust") {
      entry.trust += net;
    } else if (r.name === "Dealer_self" || r.name === "Dealer_Hedging") {
      entry.dealer += net;
    }
    byDate.set(r.date, entry);
  }

  const todayEntry = byDate.get(todayStr) ?? { foreign: 0, trust: 0, dealer: 0 };
  const foreignNet = todayEntry.foreign;
  const trustNet = todayEntry.trust;
  const dealerNet = todayEntry.dealer;

  // Build detector input: sorted-by-date array with net-shares per faction
  const detectorRows = Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, e]) => ({
      date,
      netSharesForeign: e.foreign,
      netSharesTrust: e.trust,
      netSharesDealer: e.dealer,
    }));

  const detection = detectInstitutionalAnomaly(detectorRows);

  let instAnomaly: EnrichedRow["instAnomaly"] = null;
  if (detection.isAnomaly && detection.direction) {
    const absAvg = Math.abs(detection.avgNetLots);
    const absToday = Math.abs(detection.todayNetLots);
    const multiplier = absAvg > 0 ? absToday / absAvg : 0;
    instAnomaly = {
      direction: detection.direction,
      todayLots: detection.todayNetLots,
      avgLots: detection.avgNetLots,
      multiplier,
    };
  }

  // Watch list lookup — O(N) linear scan; watchList is usually < 100 entries
  const watchEntry = watchList.find((w) => w.stockId === stockId);
  const watchListReason = watchEntry?.reason ?? null;

  // Convert shares → 張 (round to integer)
  const toZhang = (shares: number) => Math.round(shares / 1000);

  // Fetch industry from tips
  const industryCategory = await fetchIndustry(stockId);

  return {
    ...row,
    stockId,
    industryCategory,
    todayOhlcv,
    prevClose,
    dailyChangePct,
    currentPrice,
    marketValue,
    costBasis,
    pnl,
    pnlPct,
    institutionalForeign: toZhang(foreignNet),
    institutionalTrust: toZhang(trustNet),
    institutionalDealer: toZhang(dealerNet),
    watchListReason,
    instAnomaly,
  };
}

// ─── Message builder ──────────────────────────────────────────────────────────

function buildReportMessage(
  rows: EnrichedRow[],
  todayStr: string
): string {
  const wday = weekdayLabel(todayStr);

  // Totals
  const totalMarketValue = rows.reduce(
    (acc, r) => acc + (r.marketValue ?? 0),
    0
  );
  const totalCost = rows.reduce((acc, r) => acc + r.costBasis, 0);

  // Daily change = sum of (today_close - prev_close) * sharesLots * 1000
  // Only for rows where we have both prices
  let totalDailyChange = 0;
  let hasDailyChange = false;
  for (const r of rows) {
    if (r.currentPrice !== null && r.prevClose !== null) {
      totalDailyChange +=
        (r.currentPrice - r.prevClose) * r.sharesLots * 1000;
      hasDailyChange = true;
    }
  }

  const totalPnl = totalMarketValue > 0 ? totalMarketValue - totalCost : null;
  const totalPnlPct =
    totalPnl !== null && totalCost > 0
      ? (totalPnl / totalCost) * 100
      : null;
  const totalDailyPct =
    hasDailyChange && totalCost > 0
      ? (totalDailyChange / totalCost) * 100
      : null;

  const lines: string[] = [];

  lines.push(`📊 <b>今日持股收盤報告</b>`);
  lines.push(`${todayStr}（${wday}）`);
  lines.push(``);
  lines.push(`<b>整體表現</b>`);
  lines.push(
    `總市值：NT$${fmtNum(Math.round(totalMarketValue))}`
  );

  if (hasDailyChange && totalDailyPct !== null) {
    const sign = totalDailyChange >= 0 ? "+" : "";
    lines.push(
      `今日變動：${sign}NT$${fmtNum(Math.round(totalDailyChange))}（${fmtSign(totalDailyPct, 2)}%）`
    );
  }

  if (totalPnl !== null && totalPnlPct !== null) {
    const sign = totalPnl >= 0 ? "+" : "";
    lines.push(
      `未實現損益：${sign}NT$${fmtNum(Math.round(totalPnl))}（${fmtSign(totalPnlPct, 2)}%）`
    );
  }

  lines.push(``);
  lines.push(`—————————————`);

  rows.forEach((r, idx) => {
    lines.push(``);

    const header = r.industryCategory
      ? `<b>${idx + 1}. ${r.stockId} ｜ ${r.industryCategory}</b>`
      : `<b>${idx + 1}. ${r.stockId}</b>`;
    lines.push(header);

    if (r.currentPrice !== null) {
      const icon =
        r.dailyChangePct === null
          ? "📊"
          : r.dailyChangePct >= 0
          ? "📈"
          : "📉";
      const pctStr =
        r.dailyChangePct !== null
          ? `（${fmtSign(r.dailyChangePct, 2)}%）`
          : "";
      lines.push(`${icon} 收盤 ${r.currentPrice}${pctStr}`);
    } else {
      lines.push(`📊 今日無收盤資料`);
    }

    lines.push(
      `持有 ${r.sharesLots} 張｜成本 ${r.avgCost.toFixed(2)}`
    );

    if (r.marketValue !== null && r.pnl !== null && r.pnlPct !== null) {
      const sign = r.pnl >= 0 ? "+" : "";
      lines.push(
        `市值 NT$${fmtNum(Math.round(r.marketValue))}（${sign}NT$${fmtNum(Math.round(r.pnl))}）`
      );
    }

    // Institutional investors
    const instTotal =
      r.institutionalForeign + r.institutionalTrust + r.institutionalDealer;
    if (
      r.institutionalForeign !== 0 ||
      r.institutionalTrust !== 0 ||
      r.institutionalDealer !== 0
    ) {
      lines.push(``);
      lines.push(`三大法人（張）：`);
      lines.push(
        `  外資 ${fmtSign(r.institutionalForeign)}  投信 ${fmtSign(r.institutionalTrust)}  自營商 ${fmtSign(r.institutionalDealer)}`
      );
      lines.push(`  合計 ${fmtSign(instTotal)}`);
    }

    // Chip anomaly flags (merged from T5 — was sent separately at 18:00)
    if (r.watchListReason) {
      lines.push(``);
      lines.push(`⚠️ <b>列入注意股/處置股</b>：${r.watchListReason}`);
    }
    if (r.instAnomaly) {
      const label = r.instAnomaly.direction === "buy" ? "異常買超" : "異常賣超";
      const ratio = r.instAnomaly.multiplier.toFixed(1);
      lines.push(``);
      lines.push(
        `🚨 <b>法人${label}</b>：${fmtSign(r.instAnomaly.todayLots)} 張（20 日均 ${fmtSign(r.instAnomaly.avgLots)}，約 ${ratio} 倍）`
      );
    }
  });

  lines.push(``);
  lines.push(`—————————————`);
  lines.push(``);
  lines.push(`輸入 /portfolio 查看完整持股`);

  return lines.join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══ T4 Daily Closing Report started ═══");
  const startMs = Date.now();

  const today = todayTaipei();
  console.log(`Report date: ${today}`);

  const userIds = await fetchUsersWithHoldings();

  if (userIds.length === 0) {
    console.log("No users with holdings — exiting.");
    await pg.end();
    return;
  }

  console.log(`Found ${userIds.length} user(s) with holdings`);

  // ── Non-trading day guard ────────────────────────────────────────────────
  // Use the first user's first holding as a probe. If today has no OHLCV
  // data, it's a non-trading day and we skip the entire run.
  const probeUserId = userIds[0]!;
  const probeHoldings = await fetchHoldings(probeUserId);

  if (probeHoldings.length === 0) {
    console.log(`User ${probeUserId} has no holdings (race condition?) — exiting.`);
    await pg.end();
    return;
  }

  const probeSymbol = stripSuffix(probeHoldings[0]!.symbol);
  console.log(`Non-trading day probe: ${probeSymbol} for ${today}`);

  const probeOhlcv = await fetchDailyOHLCV(probeSymbol, today);
  await sleep(FINMIND_SLEEP_MS);

  const hasToday = probeOhlcv !== null && probeOhlcv.some((r) => r.date === today);

  if (!hasToday) {
    console.log(`No trading data found for ${today} — non-trading day, skipping.`);
    await pg.end();
    return;
  }

  console.log(`Trading day confirmed for ${today}`);

  // ── Fetch watch list once, shared across all users/holdings ──────────────
  const watchListData = await fetchWatchList();
  await sleep(FINMIND_SLEEP_MS);
  const watchList: WatchListEntry[] = watchListData ?? [];
  console.log(`Watch list: ${watchList.length} stocks flagged`);

  // ── Per-user loop ────────────────────────────────────────────────────────
  for (const userId of userIds) {
    console.log(`\nProcessing user: ${userId}`);

    const telegramId = await fetchTelegramId(userId);
    if (!telegramId) {
      console.log(`  → No Telegram ID, skipping`);
      continue;
    }

    const userHoldings = await fetchHoldings(userId);
    if (userHoldings.length === 0) {
      console.log(`  → No holdings, skipping`);
      continue;
    }

    console.log(`  Holdings: ${userHoldings.map((h) => h.symbol).join(", ")}`);

    // Enrich each holding sequentially (rate limit between each call)
    const enriched: EnrichedRow[] = [];
    for (const h of userHoldings) {
      console.log(`    Enriching ${h.symbol}...`);
      const row = await enrichHolding(h, today, watchList);
      enriched.push(row);
      console.log(
        `    → close=${row.currentPrice ?? "N/A"} dailyPct=${row.dailyChangePct?.toFixed(2) ?? "N/A"}%`
      );
    }

    // Skip if none of the holdings have today's data
    const anyTodayData = enriched.some((r) => r.todayOhlcv !== null);
    if (!anyTodayData) {
      console.log(`  → No today data for any holding, skipping user`);
      continue;
    }

    const message = buildReportMessage(enriched, today);

    const sent = await sendMessage({
      chat_id: telegramId,
      text: message,
      parse_mode: "HTML",
    });

    if (sent) {
      console.log(`  ✓ Report sent (message_id=${sent.message_id})`);
    } else {
      console.warn(`  ✗ Failed to send report to user ${userId}`);
    }

    await sleep(TELEGRAM_SLEEP_MS);
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`\n═══ Done in ${elapsed}s ═══`);
  await pg.end();
}

main().catch((err) => {
  console.error("Worker crashed:", err);
  process.exit(1);
});
