#!/usr/bin/env bun
/**
 * T11 — Price Target Monitor
 *
 * Runs daily (via GitHub Actions cron). For each pending tip_verification
 * that has a target_price set, fetches the current market price and checks
 * whether the target has been reached.
 *
 * Hit criteria:
 *   bullish tip → current price >= target_price
 *   bearish tip → current price <= target_price
 *
 * When hit: marks result='hit', records priceAtCheck, and sends the original
 * user a Telegram push notification.
 *
 * Neutral tips and tips without a target_price are skipped entirely.
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, and, isNotNull, ne } from "drizzle-orm";

import { tips } from "@/lib/db/schema/tips";
import { tipVerifications } from "@/lib/db/schema/verifications";

import { fetchCurrentPrice } from "@/lib/price/client";
import { sendMessage } from "@/lib/telegram/client";

// ─── Config ───────────────────────────────────────────────────────────────────

const BATCH_SIZE = 20;

// ─── DB setup ─────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env["DATABASE_URL"];
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not set");
  process.exit(1);
}

const pg = postgres(DATABASE_URL, { max: 3, prepare: false });
const db = drizzle(pg);

// ─── Types ────────────────────────────────────────────────────────────────────

interface PendingTarget {
  verificationId: string;
  tipId: string;
  priceAtTip: string;
  targetPrice: string;
  ticker: string;
  market: "TW" | "US" | "CRYPTO";
  sentiment: "bullish" | "bearish";
  telegramChatId: number;
  createdAt: Date;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isHit(
  currentPrice: number,
  targetPrice: number,
  sentiment: "bullish" | "bearish"
): boolean {
  if (sentiment === "bullish") return currentPrice >= targetPrice;
  return currentPrice <= targetPrice; // bearish
}

function buildHitMessage(opts: {
  ticker: string;
  market: "TW" | "US" | "CRYPTO";
  sentiment: "bullish" | "bearish";
  targetPrice: number;
  priceAtCheck: number;
  priceAtTip: number;
  daysElapsed: number;
}): string {
  const currency = opts.market === "TW" ? "NT$" : opts.market === "CRYPTO" ? "" : "$";
  const dirIcon = opts.sentiment === "bullish" ? "📈" : "📉";
  const dirLabel = opts.sentiment === "bullish" ? "看多" : "看空";
  const pct = (((opts.priceAtCheck - opts.priceAtTip) / opts.priceAtTip) * 100).toFixed(2);
  const pctStr = `${Number(pct) >= 0 ? "+" : ""}${pct}%`;

  return [
    `🎯 <b>目標價達標！</b>`,
    "",
    `<b>標的：</b>${opts.ticker}`,
    `<b>方向：</b>${dirIcon} ${dirLabel}`,
    `<b>目標價：</b>${currency}${opts.targetPrice.toFixed(2)}`,
    `<b>目前價：</b>${currency}${opts.priceAtCheck.toFixed(2)}`,
    `<b>進場價：</b>${currency}${opts.priceAtTip.toFixed(2)}（${pctStr}）`,
    "",
    `你在 ${opts.daysElapsed} 天前提的情報達標了 🎉`,
  ].join("\n");
}

// ─── Query pending targets ─────────────────────────────────────────────────────

async function fetchPendingTargets(): Promise<PendingTarget[]> {
  const rows = await db
    .select({
      verificationId: tipVerifications.id,
      tipId: tipVerifications.tipId,
      priceAtTip: tipVerifications.priceAtTip,
      targetPrice: tipVerifications.targetPrice,
      ticker: tips.ticker,
      market: tips.market,
      sentiment: tips.sentiment,
      telegramChatId: tips.telegramChatId,
      createdAt: tipVerifications.createdAt,
    })
    .from(tipVerifications)
    .innerJoin(tips, eq(tipVerifications.tipId, tips.id))
    .where(
      and(
        eq(tipVerifications.result, "pending"),
        isNotNull(tipVerifications.targetPrice),
        isNotNull(tipVerifications.priceAtTip),
        isNotNull(tips.ticker),
        isNotNull(tips.market),
        isNotNull(tips.sentiment),
        ne(tips.sentiment, "neutral")
      )
    )
    .limit(BATCH_SIZE);

  return rows.filter(
    (r): r is typeof r & {
      priceAtTip: string;
      targetPrice: string;
      ticker: string;
      market: "TW" | "US" | "CRYPTO";
      sentiment: "bullish" | "bearish";
    } =>
      r.priceAtTip !== null &&
      r.targetPrice !== null &&
      r.ticker !== null &&
      r.market !== null &&
      r.sentiment !== null &&
      r.sentiment !== "neutral"
  ) as PendingTarget[];
}

// ─── Process one target ───────────────────────────────────────────────────────

async function processTarget(row: PendingTarget): Promise<void> {
  const {
    verificationId, ticker, market, sentiment,
    priceAtTip: priceAtTipStr, targetPrice: targetPriceStr, createdAt,
  } = row;

  const priceAtTip = parseFloat(priceAtTipStr);
  const targetPrice = parseFloat(targetPriceStr);

  if (!isFinite(priceAtTip) || !isFinite(targetPrice) || targetPrice <= 0) {
    console.warn(`  ⚠ ${ticker} — invalid prices: tip=${priceAtTipStr} target=${targetPriceStr}`);
    return;
  }

  const currentPrice = await fetchCurrentPrice(ticker, market);
  if (currentPrice === null) {
    console.warn(`  ✗ ${ticker} — price fetch failed, will retry tomorrow`);
    return;
  }

  const hit = isHit(currentPrice, targetPrice, sentiment);
  const dirIcon = sentiment === "bullish" ? "▲" : "▼";
  console.log(
    `  ${hit ? "🎯" : "·"} ${ticker} ${dirIcon} target=${targetPrice} current=${currentPrice} → ${hit ? "HIT" : "pending"}`
  );

  if (!hit) return; // not there yet, check again tomorrow

  const daysElapsed = Math.floor(
    (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24)
  );

  // Mark as hit
  await db
    .update(tipVerifications)
    .set({
      priceAtCheck: currentPrice.toString(),
      result: "hit",
      checkedAt: new Date(),
    })
    .where(eq(tipVerifications.id, verificationId));

  // Notify user
  try {
    const text = buildHitMessage({
      ticker,
      market,
      sentiment,
      targetPrice,
      priceAtCheck: currentPrice,
      priceAtTip,
      daysElapsed,
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
  console.log("═══ T11 Price Target Monitor started ═══");
  const startMs = Date.now();

  const pending = await fetchPendingTargets();

  if (pending.length === 0) {
    console.log("No pending targets — exiting.");
    await pg.end();
    return;
  }

  console.log(`Checking ${pending.length} target(s)`);

  for (const row of pending) {
    await processTarget(row);
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`═══ Done in ${elapsed}s ═══`);
  await pg.end();
}

main().catch((err) => {
  console.error("Worker crashed:", err);
  process.exit(1);
});
