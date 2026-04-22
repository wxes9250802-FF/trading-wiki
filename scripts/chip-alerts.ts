#!/usr/bin/env bun
/**
 * T5 — Chip Anomaly Alerts
 *
 * Runs every weekday at 18:00 TST (10:00 UTC) via GitHub Actions.
 * Scans all symbols in the holdings table for two anomaly types:
 *
 *   1. watch       — stock is on today's TWSE notice or punishment list
 *   2. institutional — today's 三大法人 net lots >= 3× 20-day average
 *                     (with a minimum of ±500 lots to filter out cold stocks)
 *
 * Alerts are sent only to users who hold the flagged symbol.
 * Each (symbol, date) pair is pushed at most once per day via chip_alert_log.
 *
 * Non-trading day guard:
 *   If fetchWatchList() returns null AND FinMind returns no data for the
 *   probe symbol, the run is skipped entirely — no messages sent.
 *
 * Rate-limit discipline:
 *   - 300 ms between every FinMind API call
 *   - 500 ms between sending each Telegram message
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql as drizzleSql } from "drizzle-orm";

import { chipAlertLog } from "@/lib/db/schema/chip-alerts";
import { userProfiles } from "@/lib/db/schema/users";
import { holdings } from "@/lib/db/schema/holdings";

import {
  fetchWatchList,
  fetchInstitutionalInvestors,
  WatchListItem,
} from "@/lib/finmind/client";
import { detectInstitutionalAnomaly, InstitutionalRow } from "@/lib/chip-analysis/detector";
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

type AlertType = "watch" | "institutional";

interface SymbolAlert {
  symbol: string;     // plain stock id, e.g. "2330"
  stockName: string;  // from watch list or empty string
  alertTypes: AlertType[];
  watchReason?: string;
  institutionalDirection?: "buy" | "sell";
  todayNetLots?: number;
  avgNetLots?: number;
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
  const taipei = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return taipei.toISOString().slice(0, 10);
}

/** N days before today in Taipei time. */
function daysAgoTaipei(n: number): string {
  const now = new Date();
  const taipei = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  taipei.setDate(taipei.getDate() - n);
  return taipei.toISOString().slice(0, 10);
}

function fmtSign(n: number): string {
  return n >= 0 ? `+${n.toLocaleString("zh-TW")}` : n.toLocaleString("zh-TW");
}

// ─── DB queries ───────────────────────────────────────────────────────────────

/** All distinct stock symbols that have at least one active holding. */
async function fetchHeldSymbols(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ symbol: holdings.symbol })
    .from(holdings);
  return rows.map((r) => r.symbol);
}

/**
 * Telegram IDs of users who hold the given symbol and have a telegram_id set.
 * symbol may include suffix (e.g. "2330.TW") or be bare (e.g. "2330").
 */
async function fetchHolderTelegramIds(symbol: string): Promise<number[]> {
  // holdings.symbol stores with suffix (e.g. "2330.TW"), so we match both forms
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

/** Returns true if this symbol has already been alerted today. */
async function isAlreadyAlerted(symbol: string, todayStr: string): Promise<boolean> {
  const rows = await db.execute(
    drizzleSql`
      SELECT 1 FROM chip_alert_log
      WHERE symbol = ${symbol} AND alert_date = ${todayStr}
      LIMIT 1
    `
  );
  return (rows as unknown[]).length > 0;
}

/** Records that this symbol was alerted today. */
async function recordAlert(symbol: string, todayStr: string, alertTypes: AlertType[]): Promise<void> {
  await db.insert(chipAlertLog).values({
    symbol,
    alertDate: todayStr,
    alertTypes,
  }).onConflictDoNothing();
}

// ─── Message builder ──────────────────────────────────────────────────────────

function buildAlertMessage(alert: SymbolAlert, todayStr: string): string {
  const lines: string[] = [];

  lines.push(`⚠️ <b>籌碼異常提醒</b>`);
  lines.push(todayStr);
  lines.push(``);

  const titleName = alert.stockName
    ? `${alert.symbol} ${alert.stockName}`
    : alert.symbol;
  lines.push(`<b>${titleName}</b>`);

  if (alert.alertTypes.includes("watch") && alert.watchReason) {
    lines.push(``);
    lines.push(`🚨 列入注意／處置股`);
    lines.push(`  原因：${alert.watchReason}`);
  }

  if (
    alert.alertTypes.includes("institutional") &&
    alert.institutionalDirection !== undefined &&
    alert.todayNetLots !== undefined &&
    alert.avgNetLots !== undefined
  ) {
    const dirLabel = alert.institutionalDirection === "buy" ? "異常買超" : "異常賣超";
    const multiple =
      alert.avgNetLots !== 0
        ? (Math.abs(alert.todayNetLots) / Math.abs(alert.avgNetLots)).toFixed(1)
        : "∞";

    lines.push(``);
    lines.push(`📊 法人${dirLabel}`);
    lines.push(
      `  今日淨${alert.institutionalDirection === "buy" ? "買" : "賣"}超：${fmtSign(alert.todayNetLots)} 張`
    );
    lines.push(`  近 20 日平均：${fmtSign(alert.avgNetLots)} 張`);
    lines.push(`  （約 ${multiple} 倍）`);
  }

  lines.push(``);
  lines.push(`請留意後續走勢，本提醒不構成投資建議。`);

  return lines.join("\n");
}

// ─── Institutional data aggregation ──────────────────────────────────────────

/**
 * Aggregate raw FinMind institutional rows into per-day InstitutionalRow objects.
 * Groups by date and sums each bucket (foreign / trust / dealer).
 */
function aggregateInstitutional(
  raw: Array<{
    date: string;
    name: "Foreign_Investor" | "Investment_Trust" | "Dealer_self" | "Dealer_Hedging" | "Foreign_Dealer_Self";
    buy: number;
    sell: number;
  }>
): InstitutionalRow[] {
  const map = new Map<string, InstitutionalRow>();

  for (const r of raw) {
    const net = r.buy - r.sell;
    if (!map.has(r.date)) {
      map.set(r.date, { date: r.date, netSharesForeign: 0, netSharesTrust: 0, netSharesDealer: 0 });
    }
    const row = map.get(r.date)!;

    if (r.name === "Foreign_Investor" || r.name === "Foreign_Dealer_Self") {
      row.netSharesForeign += net;
    } else if (r.name === "Investment_Trust") {
      row.netSharesTrust += net;
    } else if (r.name === "Dealer_self" || r.name === "Dealer_Hedging") {
      row.netSharesDealer += net;
    }
  }

  return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══ T5 Chip Anomaly Alerts started ═══");
  const startMs = Date.now();

  const today = todayTaipei();
  console.log(`Alert date: ${today}`);

  // ── Step 1: Held symbols ──────────────────────────────────────────────────
  const heldSymbols = await fetchHeldSymbols();
  if (heldSymbols.length === 0) {
    console.log("No holdings in DB — exiting.");
    await pg.end();
    return;
  }
  console.log(`Held symbols: ${heldSymbols.map(stripSuffix).join(", ")}`);

  // ── Step 2: Watch list ────────────────────────────────────────────────────
  const watchList = await fetchWatchList();
  if (watchList === null) {
    console.warn("fetchWatchList() returned null — both TWSE endpoints failed. Continuing without watch data.");
  } else {
    console.log(`Watch list: ${watchList.length} item(s)`);
  }

  const watchMap = new Map<string, WatchListItem>();
  for (const item of watchList ?? []) {
    watchMap.set(item.stockId, item);
  }

  // ── Step 3: Non-trading day guard ─────────────────────────────────────────
  // Use the first held symbol as a probe for institutional data availability.
  // If FinMind has no data for today, it's a non-trading day.
  const probeId = stripSuffix(heldSymbols[0]!);
  console.log(`Non-trading day probe: ${probeId}`);
  const probeData = await fetchInstitutionalInvestors(probeId, today);
  await sleep(FINMIND_SLEEP_MS);

  const probeHasToday = probeData !== null && probeData.some((r) => r.date === today);

  if (!probeHasToday && (watchList === null || watchList.length === 0)) {
    console.log("No trading data for today and no watch items — non-trading day, skipping.");
    await pg.end();
    return;
  }

  console.log(probeHasToday ? "Trading day confirmed." : "No FinMind data today (possible non-trading day), but watch list has items — continuing.");

  // ── Step 4: Scan each symbol ──────────────────────────────────────────────
  const alerts: SymbolAlert[] = [];

  for (const symbol of heldSymbols) {
    const stockId = stripSuffix(symbol);

    // Skip if already alerted today
    if (await isAlreadyAlerted(stockId, today)) {
      console.log(`  [${stockId}] Already alerted today — skip`);
      continue;
    }

    const alertTypes: AlertType[] = [];
    let watchReason: string | undefined;
    let institutionalDirection: "buy" | "sell" | undefined;
    let todayNetLots: number | undefined;
    let avgNetLots: number | undefined;
    let stockName = "";

    // Check watch list
    const watchItem = watchMap.get(stockId);
    if (watchItem) {
      alertTypes.push("watch");
      watchReason = watchItem.reason;
      stockName = watchItem.stockName;
      console.log(`  [${stockId}] Watch hit: ${watchItem.reason}`);
    }

    // Check institutional anomaly (skip the probe since we already fetched it)
    const startDate = daysAgoTaipei(30); // fetch 30 calendar days → ~21 trading days
    let instRaw: Awaited<ReturnType<typeof fetchInstitutionalInvestors>>;

    if (stockId === probeId && probeData !== null) {
      instRaw = probeData;
    } else {
      instRaw = await fetchInstitutionalInvestors(stockId, startDate);
      await sleep(FINMIND_SLEEP_MS);
    }

    if (instRaw && instRaw.length > 0) {
      const aggregated = aggregateInstitutional(instRaw);
      // Only include rows up to and including today
      const window = aggregated.filter((r) => r.date <= today);

      if (window.length >= 2) {
        const result = detectInstitutionalAnomaly(window);
        if (result.isAnomaly && result.direction !== null) {
          alertTypes.push("institutional");
          institutionalDirection = result.direction;
          todayNetLots = result.todayNetLots;
          avgNetLots = result.avgNetLots;
          console.log(
            `  [${stockId}] Institutional anomaly: ${result.direction} today=${result.todayNetLots} avg=${result.avgNetLots}`
          );
        }
      }
    }

    if (alertTypes.length === 0) {
      console.log(`  [${stockId}] No anomaly`);
      continue;
    }

    alerts.push({
      symbol: stockId,
      stockName,
      alertTypes,
      watchReason,
      institutionalDirection,
      todayNetLots,
      avgNetLots,
    });
  }

  if (alerts.length === 0) {
    console.log("No anomalies detected — no messages to send.");
    await pg.end();
    return;
  }

  console.log(`\n${alerts.length} symbol(s) with anomalies. Sending alerts...`);

  // ── Step 5: Send alerts per symbol → per holder ───────────────────────────
  for (const alert of alerts) {
    console.log(`\nProcessing alert for ${alert.symbol} [${alert.alertTypes.join(", ")}]`);

    const telegramIds = await fetchHolderTelegramIds(alert.symbol);
    if (telegramIds.length === 0) {
      console.log(`  No holders with Telegram IDs — skip`);
      continue;
    }

    const message = buildAlertMessage(alert, today);

    let sentCount = 0;
    for (const chatId of telegramIds) {
      const sent = await sendMessage({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
      });

      if (sent) {
        sentCount++;
        console.log(`  ✓ Sent to chat_id=${chatId}`);
      } else {
        console.warn(`  ✗ Failed to send to chat_id=${chatId}`);
      }

      await sleep(TELEGRAM_SLEEP_MS);
    }

    // Record in log (even if some sends failed — prevents re-triggering on partial failure)
    if (sentCount > 0) {
      await recordAlert(alert.symbol, today, alert.alertTypes);
      console.log(`  Logged alert for ${alert.symbol} on ${today}`);
    }
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`\n═══ Done in ${elapsed}s ═══`);
  await pg.end();
}

main().catch((err) => {
  console.error("Worker crashed:", err);
  process.exit(1);
});
