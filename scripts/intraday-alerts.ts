#!/usr/bin/env bun
/**
 * T6 — Intraday Price & Volume Alerts
 *
 * Runs at 09:30, 10:30, 11:30, 12:30, 13:30 TST on weekdays (GitHub Actions).
 * Scans all distinct symbols in the holdings table and fires Telegram alerts
 * when:
 *
 *   price_up:     today close vs prev close >= +5%
 *   price_down:   today close vs prev close <= -5%
 *   volume_spike: today volume >= 20-day avg volume × 2.5
 *
 * Each (symbol, alert_type) pair is pushed at most once per trading day via
 * the intraday_alert_log deduplication table.
 *
 * Non-trading day guard:
 *   If detectIntradayAlerts() returns today = null (FinMind has no data for
 *   the current date), that symbol is skipped — no spurious alerts.
 *
 * Rate-limit discipline:
 *   - 300 ms between every FinMind API call
 *   - 300 ms between sending each Telegram message
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql as drizzleSql } from "drizzle-orm";

import { intradayAlertLog } from "@/lib/db/schema/intraday-alerts";
import { holdings } from "@/lib/db/schema/holdings";
import { fetchDailyOHLCV } from "@/lib/finmind/client";
import {
  detectIntradayAlerts,
  AlertType,
  OHLCVRow,
} from "@/lib/intraday-alerts/detector";
import { sendMessage } from "@/lib/telegram/client";

// ─── Config ───────────────────────────────────────────────────────────────────

const FINMIND_SLEEP_MS = 300;
const TELEGRAM_SLEEP_MS = 300;

/** Fetch 30 calendar days to ensure >= 21 trading days. */
const LOOKBACK_DAYS = 30;

// ─── DB setup ─────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env["DATABASE_URL"];
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not set");
  process.exit(1);
}

const pg = postgres(DATABASE_URL, { max: 3, prepare: false });
const db = drizzle(pg);

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
  const taipei = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return taipei.toISOString().slice(0, 10);
}

/** N calendar days before today in Taipei time. */
function daysAgoTaipei(n: number): string {
  const now = new Date();
  const taipei = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  taipei.setDate(taipei.getDate() - n);
  return taipei.toISOString().slice(0, 10);
}

function fmtPct(ratio: number): string {
  const sign = ratio >= 0 ? "+" : "";
  return `${sign}${(ratio * 100).toFixed(2)}%`;
}

function fmtVolume(vol: number): string {
  return Math.round(vol).toLocaleString("zh-TW");
}

// ─── DB queries ───────────────────────────────────────────────────────────────

/** All distinct stock symbols that appear in holdings. */
async function fetchHeldSymbols(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ symbol: holdings.symbol })
    .from(holdings);
  return rows.map((r) => r.symbol);
}

/**
 * Returns the set of alertTypes already logged for this (symbol, date).
 * Used to skip individual alertTypes that have already been pushed today.
 */
async function fetchAlertedTypesToday(
  symbol: string,
  todayStr: string
): Promise<Set<AlertType>> {
  const rows = await db.execute(
    drizzleSql`
      SELECT alert_type FROM intraday_alert_log
      WHERE symbol = ${symbol} AND alert_date = ${todayStr}
    `
  );
  const set = new Set<AlertType>();
  for (const r of rows as unknown as Array<{ alert_type: string }>) {
    set.add(r.alert_type as AlertType);
  }
  return set;
}

/**
 * Telegram IDs of users who hold the given symbol and have a telegram_id set.
 * symbol may include suffix (e.g. "2330.TW") or be bare (e.g. "2330").
 */
async function fetchHolderTelegramIds(symbol: string): Promise<number[]> {
  const bare = stripSuffix(symbol);
  const rows = await db.execute(
    drizzleSql`
      SELECT DISTINCT u.telegram_id
      FROM holdings h
      JOIN user_profiles u ON u.id = h.user_id
      WHERE (h.symbol = ${symbol} OR h.symbol LIKE ${bare + ".%"})
        AND u.telegram_id IS NOT NULL
    `
  );
  return (rows as unknown as Array<{ telegram_id: number | null }>)
    .map((r) => r.telegram_id)
    .filter((id): id is number => id !== null);
}

/** Insert a dedup log entry. ON CONFLICT DO NOTHING is handled by the UNIQUE constraint. */
async function recordAlert(
  symbol: string,
  todayStr: string,
  alertType: AlertType,
  metric: number
): Promise<void> {
  await db
    .insert(intradayAlertLog)
    .values({
      symbol,
      alertDate: todayStr,
      alertType,
      metric: String(parseFloat(metric.toFixed(4))),
    })
    .onConflictDoNothing();
}

// ─── Message builders ─────────────────────────────────────────────────────────

function buildPriceUpMessage(
  stockId: string,
  changeRatio: number,
  todayClose: number,
  prevClose: number
): string {
  return [
    `🚀 <b>你持有的 ${stockId} 急漲</b>`,
    ``,
    `今日漲幅：${fmtPct(changeRatio)}`,
    `目前價：NT$${todayClose.toLocaleString("zh-TW")}`,
    `昨收：NT$${prevClose.toLocaleString("zh-TW")}`,
    ``,
    `本提醒不構成投資建議。`,
  ].join("\n");
}

function buildPriceDownMessage(
  stockId: string,
  changeRatio: number,
  todayClose: number,
  prevClose: number
): string {
  return [
    `⚠️ <b>你持有的 ${stockId} 急跌</b>`,
    ``,
    `今日跌幅：${fmtPct(changeRatio)}`,
    `目前價：NT$${todayClose.toLocaleString("zh-TW")}`,
    `昨收：NT$${prevClose.toLocaleString("zh-TW")}`,
    ``,
    `請留意後續走勢，本提醒不構成投資建議。`,
  ].join("\n");
}

function buildVolumeSpikeMessage(
  stockId: string,
  multiplier: number,
  todayVolume: number,
  avg20Volume: number
): string {
  return [
    `📣 <b>你持有的 ${stockId} 出現爆量</b>`,
    ``,
    `今日成交量：${fmtVolume(todayVolume)} 張`,
    `近 20 日均量：${fmtVolume(avg20Volume)} 張`,
    `倍數：約 ${multiplier.toFixed(2)} 倍`,
    ``,
    `通常伴隨重要新聞或籌碼異動，請留意。`,
  ].join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══ T6 Intraday Alerts started ═══");
  const startMs = Date.now();

  const today = todayTaipei();
  const startDate = daysAgoTaipei(LOOKBACK_DAYS);
  console.log(`Alert date: ${today} | Fetch from: ${startDate}`);

  // ── Step 1: Held symbols ──────────────────────────────────────────────────
  const heldSymbols = await fetchHeldSymbols();
  if (heldSymbols.length === 0) {
    console.log("No holdings in DB — exiting.");
    await pg.end();
    return;
  }
  console.log(`Held symbols: ${heldSymbols.map(stripSuffix).join(", ")}`);

  // ── Step 2: Scan each symbol ──────────────────────────────────────────────
  let totalSent = 0;

  for (const symbol of heldSymbols) {
    const stockId = stripSuffix(symbol);
    console.log(`\n[${stockId}] Processing...`);

    // ── 2a. Check which alertTypes have already fired today ─────────────────
    const alreadyAlerted = await fetchAlertedTypesToday(stockId, today);
    const allTypes: AlertType[] = ["price_up", "price_down", "volume_spike"];

    if (allTypes.every((t) => alreadyAlerted.has(t))) {
      console.log(`  [${stockId}] All alert types already fired today — skip`);
      continue;
    }

    // ── 2b. Fetch OHLCV data ────────────────────────────────────────────────
    const ohlcv = await fetchDailyOHLCV(stockId, startDate);
    await sleep(FINMIND_SLEEP_MS);

    if (ohlcv === null) {
      console.warn(`  [${stockId}] fetchDailyOHLCV returned null — skip`);
      continue;
    }

    if (ohlcv.length < 2) {
      console.log(`  [${stockId}] Not enough data rows (${ohlcv.length}) — skip`);
      continue;
    }

    // ── 2c. Run detector ────────────────────────────────────────────────────
    const rows: OHLCVRow[] = ohlcv.map((r) => ({
      date: r.date,
      open: r.open,
      close: r.close,
      high: r.high,
      low: r.low,
      volume: r.volume,
    }));

    const { today: todayRow, alerts } = detectIntradayAlerts(rows);

    if (todayRow === null) {
      console.log(`  [${stockId}] Detector returned null today — skip (non-trading day?)`);
      continue;
    }

    // Non-trading day guard: if latest row is not today, FinMind has no data yet
    if (todayRow.date !== today) {
      console.log(
        `  [${stockId}] Latest data is ${todayRow.date}, not ${today} — non-trading day, skip`
      );
      continue;
    }

    // ── 2d. Filter out already-alerted types ────────────────────────────────
    const newAlerts = alerts.filter((a) => !alreadyAlerted.has(a.type));

    if (newAlerts.length === 0) {
      console.log(`  [${stockId}] No new alerts to send`);
      continue;
    }

    console.log(
      `  [${stockId}] New alerts: ${newAlerts.map((a) => a.type).join(", ")}`
    );

    // ── 2e. Find holder Telegram IDs ─────────────────────────────────────────
    const telegramIds = await fetchHolderTelegramIds(symbol);
    if (telegramIds.length === 0) {
      console.log(`  [${stockId}] No holders with Telegram IDs — skip`);
      continue;
    }

    // Calculate prevClose for price messages
    const sortedRows = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    const prevRow = sortedRows[sortedRows.length - 2]!;

    // Calculate avg20 for volume messages
    const historicalRows = sortedRows.slice(0, sortedRows.length - 1);
    const window20 = historicalRows.slice(-20);
    const avg20Volume =
      window20.length > 0
        ? window20.reduce((sum, r) => sum + r.volume, 0) / window20.length
        : 0;

    // ── 2f. Send per alertType × per holder ──────────────────────────────────
    for (const alert of newAlerts) {
      let message: string;

      if (alert.type === "price_up") {
        message = buildPriceUpMessage(
          stockId,
          alert.metric,
          todayRow.close,
          prevRow.close
        );
      } else if (alert.type === "price_down") {
        message = buildPriceDownMessage(
          stockId,
          alert.metric,
          todayRow.close,
          prevRow.close
        );
      } else {
        // volume_spike
        message = buildVolumeSpikeMessage(
          stockId,
          alert.metric,
          todayRow.volume,
          avg20Volume
        );
      }

      let sentCount = 0;
      for (const chatId of telegramIds) {
        const sent = await sendMessage({
          chat_id: chatId,
          text: message,
          parse_mode: "HTML",
        });

        if (sent) {
          sentCount++;
          console.log(`    ✓ [${alert.type}] Sent to chat_id=${chatId}`);
        } else {
          console.warn(`    ✗ [${alert.type}] Failed to send to chat_id=${chatId}`);
        }

        await sleep(TELEGRAM_SLEEP_MS);
      }

      // Record in dedup log after first successful send
      if (sentCount > 0) {
        await recordAlert(stockId, today, alert.type, alert.metric);
        console.log(`    Logged ${alert.type} for ${stockId} on ${today}`);
        totalSent++;
      }
    }
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`\n═══ Done — ${totalSent} alert(s) sent in ${elapsed}s ═══`);
  await pg.end();
}

main().catch((err) => {
  console.error("Worker crashed:", err);
  process.exit(1);
});
