#!/usr/bin/env bun
/**
 * T11 — Price Verification Worker
 *
 * Runs daily (via GitHub Actions cron). For each pending tip_verification
 * where enough days have elapsed since the tip was created, fetches the
 * current market price and determines whether the tip was correct.
 *
 * Hit criteria (from original design):
 *   TW / US stocks : price moved ≥ 3 % in the sentiment direction
 *   Crypto         : price moved ≥ 10 % in the sentiment direction
 *
 * Neutral tips are excluded — they carry no directional prediction.
 *
 * After updating each verification row, sends the original user a
 * Telegram push notification summarising the result.
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, and, isNotNull, ne, sql } from "drizzle-orm";

import { tips } from "@/lib/db/schema/tips";
import { tipVerifications } from "@/lib/db/schema/verifications";

import { fetchCurrentPrice } from "@/lib/price/client";
import { sendMessage } from "@/lib/telegram/client";

// ─── Config ───────────────────────────────────────────────────────────────────

const BATCH_SIZE = 20;

// ─── DB setup (standalone — avoids Next.js env validation) ───────────────────

const DATABASE_URL = process.env["DATABASE_URL"];
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not set");
  process.exit(1);
}

const pg = postgres(DATABASE_URL, { max: 3, prepare: false });
const db = drizzle(pg);

// ─── Types ────────────────────────────────────────────────────────────────────

interface DueVerification {
  verificationId: string;
  checkDays: number;
  priceAtTip: string;
  ticker: string;
  market: "TW" | "US" | "CRYPTO";
  sentiment: "bullish" | "bearish";
  telegramChatId: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Hit threshold: how much the price must move in the predicted direction.
 * Crypto is more volatile → higher bar.
 */
function hitThreshold(market: "TW" | "US" | "CRYPTO"): number {
  return market === "CRYPTO" ? 0.10 : 0.03;
}

function determineResult(
  priceAtTip: number,
  priceAtCheck: number,
  sentiment: "bullish" | "bearish",
  market: "TW" | "US" | "CRYPTO"
): "hit" | "miss" {
  const threshold = hitThreshold(market);
  const change = (priceAtCheck - priceAtTip) / priceAtTip;

  if (sentiment === "bullish") return change >= threshold ? "hit" : "miss";
  return change <= -threshold ? "hit" : "miss"; // bearish
}

function formatPct(from: number, to: number): string {
  const pct = ((to - from) / from) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

function buildResultMessage(opts: {
  result: "hit" | "miss";
  checkDays: number;
  ticker: string;
  market: "TW" | "US" | "CRYPTO";
  sentiment: "bullish" | "bearish";
  priceAtTip: number;
  priceAtCheck: number;
}): string {
  const threshold = (hitThreshold(opts.market) * 100).toFixed(0);
  const pct = formatPct(opts.priceAtTip, opts.priceAtCheck);
  const currency = opts.market === "TW" ? "NT$" : "USD";
  const icon = opts.result === "hit" ? "✅" : "❌";
  const label = opts.result === "hit" ? "命中！" : "未命中";
  const directionNote =
    opts.sentiment === "bullish" ? `看多（需漲 ≥${threshold}%）` : `看空（需跌 ≥${threshold}%）`;

  return [
    `${icon} <b>情報驗證：${opts.checkDays} 天${label}</b>`,
    "",
    `<b>標的：</b>${opts.ticker}`,
    `<b>方向：</b>${directionNote}`,
    `<b>進場價：</b>${currency} ${opts.priceAtTip.toFixed(2)}`,
    `<b>驗證價：</b>${currency} ${opts.priceAtCheck.toFixed(2)}`,
    `<b>漲跌幅：</b>${pct}`,
  ].join("\n");
}

// ─── Query due verifications ──────────────────────────────────────────────────

async function fetchDueVerifications(): Promise<DueVerification[]> {
  const rows = await db
    .select({
      verificationId: tipVerifications.id,
      checkDays: tipVerifications.checkDays,
      priceAtTip: tipVerifications.priceAtTip,
      ticker: tips.ticker,
      market: tips.market,
      sentiment: tips.sentiment,
      telegramChatId: tips.telegramChatId,
    })
    .from(tipVerifications)
    .innerJoin(tips, eq(tipVerifications.tipId, tips.id))
    .where(
      and(
        eq(tipVerifications.result, "pending"),
        isNotNull(tipVerifications.priceAtTip),
        isNotNull(tips.ticker),
        isNotNull(tips.market),
        isNotNull(tips.sentiment),
        ne(tips.sentiment, "neutral"),
        // Check if the required days have elapsed since tip creation
        sql`NOW() >= ${tips.createdAt} + (${tipVerifications.checkDays} * INTERVAL '1 day')`
      )
    )
    .limit(BATCH_SIZE);

  // Filter and narrow types (null checks already done in WHERE but TypeScript
  // doesn't know that — we filter here so downstream code is clean)
  return rows
    .filter(
      (r): r is typeof r & {
        priceAtTip: string;
        ticker: string;
        market: "TW" | "US" | "CRYPTO";
        sentiment: "bullish" | "bearish";
      } =>
        r.priceAtTip !== null &&
        r.ticker !== null &&
        r.market !== null &&
        r.sentiment !== null &&
        r.sentiment !== "neutral"
    )
    .map((r) => ({
      verificationId: r.verificationId,
      checkDays: r.checkDays,
      priceAtTip: r.priceAtTip,
      ticker: r.ticker,
      market: r.market,
      sentiment: r.sentiment,
      telegramChatId: r.telegramChatId,
    }));
}

// ─── Process one verification ─────────────────────────────────────────────────

async function processVerification(row: DueVerification): Promise<void> {
  const { verificationId, checkDays, ticker, market, sentiment, priceAtTip: priceAtTipStr } =
    row;

  const priceAtTip = parseFloat(priceAtTipStr);
  if (!isFinite(priceAtTip) || priceAtTip <= 0) {
    console.warn(`  ⚠ ${ticker} (${checkDays}d) — invalid priceAtTip: ${priceAtTipStr}`);
    return;
  }

  // Fetch current price
  const priceAtCheck = await fetchCurrentPrice(ticker, market);
  if (priceAtCheck === null) {
    console.warn(`  ✗ ${ticker} (${checkDays}d) — price fetch failed, will retry tomorrow`);
    return;
  }

  const result = determineResult(priceAtTip, priceAtCheck, sentiment, market);
  const pct = formatPct(priceAtTip, priceAtCheck);
  const icon = result === "hit" ? "✓" : "✗";
  console.log(`  ${icon} ${ticker} (${checkDays}d) → ${result} (${pct})`);

  // Persist result
  await db
    .update(tipVerifications)
    .set({
      priceAtCheck: priceAtCheck.toString(),
      result,
      checkedAt: new Date(),
    })
    .where(eq(tipVerifications.id, verificationId));

  // Notify user (non-fatal if it fails)
  try {
    const text = buildResultMessage({
      result,
      checkDays,
      ticker,
      market,
      sentiment,
      priceAtTip,
      priceAtCheck,
    });

    await sendMessage({
      chat_id: row.telegramChatId,
      text,
      parse_mode: "HTML",
    });
  } catch (notifyErr) {
    console.warn(`  ⚠ notification failed: ${String(notifyErr)}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══ T11 Verification Worker started ═══");
  const startMs = Date.now();

  const due = await fetchDueVerifications();

  if (due.length === 0) {
    console.log("No verifications due — exiting.");
    await pg.end();
    return;
  }

  console.log(`Found ${due.length} verification(s) due`);

  for (const row of due) {
    await processVerification(row);
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`═══ Done in ${elapsed}s ═══`);
  await pg.end();
}

main().catch((err) => {
  console.error("Worker crashed:", err);
  process.exit(1);
});
