#!/usr/bin/env bun
/**
 * T6 — Intraday Price & Volume Alerts
 *
 * Runs at 09:30, 10:30, 11:30, 12:30, 13:30 TST on weekdays (GitHub Actions).
 *
 * Alerts are driven by the `price_alerts` table — users opt in via
 * /alert <symbol> <thresholds> in Telegram. No global defaults: if a user
 * hasn't set an alert for a symbol, nothing fires.
 *
 * Alert types:
 *   price_up:     todayChangePct >= user's up_pct
 *   price_down:   todayChangePct <= user's down_pct (stored as negative)
 *   volume_spike: today.volume / avg(prev 20d volume) >= user's volume_multiplier
 *
 * Each (user, symbol, alert_type) pair pushes at most once per trading day via
 * the intraday_alert_log deduplication table.
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
import { fetchDailyOHLCV } from "@/lib/finmind/client";
import { sendMessage } from "@/lib/telegram/client";

// ─── Config ───────────────────────────────────────────────────────────────────

const FINMIND_SLEEP_MS = 300;
const TELEGRAM_SLEEP_MS = 300;
const LOOKBACK_DAYS = 30;

// ─── DB setup ─────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env["DATABASE_URL"];
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not set");
  process.exit(1);
}

const pg = postgres(DATABASE_URL, { max: 3, prepare: false });
const db = drizzle(pg);

type AlertType = "price_up" | "price_down" | "volume_spike";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripSuffix(symbol: string): string {
  return symbol.replace(/\.(TW|TWO)$/i, "");
}

function todayTaipei(): string {
  const now = new Date();
  const taipei = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return taipei.toISOString().slice(0, 10);
}

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

interface EnabledAlert {
  userId: string;
  telegramId: number;
  symbol: string;                 // canonical e.g. "2330.TW"
  upPct: number | null;           // positive, e.g. 3 (means +3%)
  downPct: number | null;         // negative, e.g. -5 (means -5%)
  volumeMultiplier: number | null; // positive, e.g. 2.5
}

/**
 * Fetch all enabled alerts joined with the owner's telegram_id.
 * Grouped later by symbol to batch OHLCV fetches.
 */
async function fetchEnabledAlerts(): Promise<EnabledAlert[]> {
  const rows = await db.execute(
    drizzleSql`
      SELECT
        pa.user_id,
        u.telegram_id,
        pa.symbol,
        pa.up_pct,
        pa.down_pct,
        pa.volume_multiplier
      FROM price_alerts pa
      JOIN user_profiles u ON u.id = pa.user_id
      WHERE pa.enabled = true
        AND u.telegram_id IS NOT NULL
    `
  );

  type Row = {
    user_id: string;
    telegram_id: number | string;
    symbol: string;
    up_pct: string | number | null;
    down_pct: string | number | null;
    volume_multiplier: string | number | null;
  };

  return (rows as unknown as Row[]).map((r) => ({
    userId: r.user_id,
    telegramId: typeof r.telegram_id === "string" ? parseInt(r.telegram_id, 10) : r.telegram_id,
    symbol: r.symbol,
    upPct: r.up_pct === null ? null : typeof r.up_pct === "string" ? parseFloat(r.up_pct) : r.up_pct,
    downPct: r.down_pct === null ? null : typeof r.down_pct === "string" ? parseFloat(r.down_pct) : r.down_pct,
    volumeMultiplier:
      r.volume_multiplier === null
        ? null
        : typeof r.volume_multiplier === "string"
        ? parseFloat(r.volume_multiplier)
        : r.volume_multiplier,
  }));
}

/**
 * Returns set of alert types already logged today for (user, symbol).
 */
async function fetchAlertedTypesToday(
  userId: string,
  symbol: string,
  todayStr: string
): Promise<Set<AlertType>> {
  const rows = await db.execute(
    drizzleSql`
      SELECT alert_type FROM intraday_alert_log
      WHERE user_id = ${userId}
        AND symbol = ${symbol}
        AND alert_date = ${todayStr}
    `
  );
  const set = new Set<AlertType>();
  for (const r of rows as unknown as Array<{ alert_type: string }>) {
    set.add(r.alert_type as AlertType);
  }
  return set;
}

async function recordAlert(
  userId: string,
  symbol: string,
  todayStr: string,
  alertType: AlertType,
  metric: number
): Promise<void> {
  await db
    .insert(intradayAlertLog)
    .values({
      userId,
      symbol,
      alertDate: todayStr,
      alertType,
      metric: String(parseFloat(metric.toFixed(4))),
    })
    .onConflictDoNothing();
}

// ─── Message builders ─────────────────────────────────────────────────────────

function buildPriceUpMessage(opts: {
  symbol: string;
  changeRatio: number;
  todayClose: number;
  prevClose: number;
  threshold: number; // user's up_pct in %
}): string {
  return [
    `🚀 <b>你關注的 ${opts.symbol} 急漲觸發</b>`,
    ``,
    `今日漲幅：${fmtPct(opts.changeRatio)}（門檻 ≥ ${opts.threshold.toFixed(1)}%）`,
    `目前價：NT$${opts.todayClose.toLocaleString("zh-TW")}`,
    `昨收：NT$${opts.prevClose.toLocaleString("zh-TW")}`,
    ``,
    `本提醒不構成投資建議。`,
  ].join("\n");
}

function buildPriceDownMessage(opts: {
  symbol: string;
  changeRatio: number;
  todayClose: number;
  prevClose: number;
  threshold: number; // user's down_pct (negative)
}): string {
  return [
    `⚠️ <b>你關注的 ${opts.symbol} 急跌觸發</b>`,
    ``,
    `今日跌幅：${fmtPct(opts.changeRatio)}（門檻 ≤ ${opts.threshold.toFixed(1)}%）`,
    `目前價：NT$${opts.todayClose.toLocaleString("zh-TW")}`,
    `昨收：NT$${opts.prevClose.toLocaleString("zh-TW")}`,
    ``,
    `請留意後續走勢，本提醒不構成投資建議。`,
  ].join("\n");
}

function buildVolumeSpikeMessage(opts: {
  symbol: string;
  multiplier: number;
  todayVolume: number;
  avg20Volume: number;
  threshold: number;
}): string {
  return [
    `📣 <b>你關注的 ${opts.symbol} 爆量觸發</b>`,
    ``,
    `今日成交量：${fmtVolume(opts.todayVolume)} 股`,
    `近 20 日均量：${fmtVolume(opts.avg20Volume)} 股`,
    `倍數：約 ${opts.multiplier.toFixed(2)} 倍（門檻 × ${opts.threshold.toFixed(1)}）`,
    ``,
    `通常伴隨重要新聞或籌碼異動，請留意。`,
  ].join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

interface OhlcvRow {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

interface SymbolStats {
  todayRow: OhlcvRow;
  prevRow: OhlcvRow;
  avg20Volume: number;
  changeRatio: number;       // (today.close - prev.close) / prev.close
  volumeMultiplier: number;  // today.volume / avg20
}

/**
 * Runs the OHLCV fetch + compute for one symbol.
 * Returns null if data is missing or today's bar isn't present (non-trading day).
 */
async function computeSymbolStats(
  symbol: string,
  todayStr: string,
  startDate: string
): Promise<SymbolStats | null> {
  const stockId = stripSuffix(symbol);
  const ohlcv = await fetchDailyOHLCV(stockId, startDate);
  await sleep(FINMIND_SLEEP_MS);

  if (ohlcv === null) {
    console.warn(`  [${stockId}] fetchDailyOHLCV returned null`);
    return null;
  }
  if (ohlcv.length < 2) {
    console.log(`  [${stockId}] Not enough data rows (${ohlcv.length})`);
    return null;
  }

  const sorted = [...ohlcv].sort((a, b) => a.date.localeCompare(b.date));
  const todayRow = sorted[sorted.length - 1]!;
  const prevRow = sorted[sorted.length - 2]!;

  if (todayRow.date !== todayStr) {
    console.log(`  [${stockId}] Latest data is ${todayRow.date}, not ${todayStr} — non-trading day`);
    return null;
  }

  const historicalRows = sorted.slice(0, sorted.length - 1);
  const window20 = historicalRows.slice(-20);
  const avg20Volume =
    window20.length > 0
      ? window20.reduce((sum, r) => sum + r.volume, 0) / window20.length
      : 0;

  const changeRatio =
    prevRow.close > 0 ? (todayRow.close - prevRow.close) / prevRow.close : 0;
  const volumeMultiplier = avg20Volume > 0 ? todayRow.volume / avg20Volume : 0;

  return { todayRow, prevRow, avg20Volume, changeRatio, volumeMultiplier };
}

async function main() {
  console.log("═══ T6 Intraday Alerts (custom thresholds) started ═══");
  const startMs = Date.now();

  const today = todayTaipei();
  const startDate = daysAgoTaipei(LOOKBACK_DAYS);
  console.log(`Alert date: ${today} | Fetch from: ${startDate}`);

  const allAlerts = await fetchEnabledAlerts();
  if (allAlerts.length === 0) {
    console.log("No enabled price alerts — exiting.");
    await pg.end();
    return;
  }
  console.log(`Enabled alerts: ${allAlerts.length}`);

  // Group alerts by symbol so we fetch OHLCV once per symbol
  const bySymbol = new Map<string, EnabledAlert[]>();
  for (const a of allAlerts) {
    const list = bySymbol.get(a.symbol) ?? [];
    list.push(a);
    bySymbol.set(a.symbol, list);
  }

  let totalSent = 0;

  for (const [symbol, alertsForSymbol] of bySymbol) {
    const stockId = stripSuffix(symbol);
    console.log(`\n[${stockId}] Processing ${alertsForSymbol.length} alert(s)...`);

    const stats = await computeSymbolStats(symbol, today, startDate);
    if (!stats) continue;

    console.log(
      `  [${stockId}] today close=${stats.todayRow.close}, change=${fmtPct(stats.changeRatio)}, volMul=${stats.volumeMultiplier.toFixed(2)}x`
    );

    for (const alert of alertsForSymbol) {
      const alreadyAlerted = await fetchAlertedTypesToday(alert.userId, symbol, today);

      // price_up: changeRatio * 100 >= upPct
      if (
        alert.upPct !== null &&
        !alreadyAlerted.has("price_up") &&
        stats.changeRatio * 100 >= alert.upPct
      ) {
        const msg = buildPriceUpMessage({
          symbol: stockId,
          changeRatio: stats.changeRatio,
          todayClose: stats.todayRow.close,
          prevClose: stats.prevRow.close,
          threshold: alert.upPct,
        });
        const sent = await sendMessage({
          chat_id: alert.telegramId,
          text: msg,
          parse_mode: "HTML",
        });
        if (sent) {
          await recordAlert(alert.userId, symbol, today, "price_up", stats.changeRatio);
          totalSent++;
          console.log(`    ✓ price_up → chat ${alert.telegramId}`);
        }
        await sleep(TELEGRAM_SLEEP_MS);
      }

      // price_down: changeRatio * 100 <= downPct (downPct is negative)
      if (
        alert.downPct !== null &&
        !alreadyAlerted.has("price_down") &&
        stats.changeRatio * 100 <= alert.downPct
      ) {
        const msg = buildPriceDownMessage({
          symbol: stockId,
          changeRatio: stats.changeRatio,
          todayClose: stats.todayRow.close,
          prevClose: stats.prevRow.close,
          threshold: alert.downPct,
        });
        const sent = await sendMessage({
          chat_id: alert.telegramId,
          text: msg,
          parse_mode: "HTML",
        });
        if (sent) {
          await recordAlert(alert.userId, symbol, today, "price_down", stats.changeRatio);
          totalSent++;
          console.log(`    ✓ price_down → chat ${alert.telegramId}`);
        }
        await sleep(TELEGRAM_SLEEP_MS);
      }

      // volume_spike
      if (
        alert.volumeMultiplier !== null &&
        !alreadyAlerted.has("volume_spike") &&
        stats.volumeMultiplier >= alert.volumeMultiplier
      ) {
        const msg = buildVolumeSpikeMessage({
          symbol: stockId,
          multiplier: stats.volumeMultiplier,
          todayVolume: stats.todayRow.volume,
          avg20Volume: stats.avg20Volume,
          threshold: alert.volumeMultiplier,
        });
        const sent = await sendMessage({
          chat_id: alert.telegramId,
          text: msg,
          parse_mode: "HTML",
        });
        if (sent) {
          await recordAlert(alert.userId, symbol, today, "volume_spike", stats.volumeMultiplier);
          totalSent++;
          console.log(`    ✓ volume_spike → chat ${alert.telegramId}`);
        }
        await sleep(TELEGRAM_SLEEP_MS);
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
