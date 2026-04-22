#!/usr/bin/env bun
/**
 * T4 — Ticker Whitelist Sync
 *
 * Fetches all listed stocks from TWSE and TPEx OpenAPI plus top-50 crypto
 * from CoinGecko, then upserts into the `tickers` table.
 *
 * Designed to run as a daily GitHub Actions cron job.
 * Can also be run locally:  bun run db:sync-tickers
 *
 * Data sources:
 *   TWSE   https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL
 *   TPEx   https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes
 *   Crypto https://api.coingecko.com/api/v3/coins/markets (top 50 by market cap)
 *   US     Static curated list — top 30 US tech / mega-cap stocks
 *
 * Symbol conventions:
 *   TWSE   → "{code}.TW"   e.g. "2330.TW"
 *   TPEx   → "{code}.TWO"  e.g. "6547.TWO"
 *   US     → "{ticker}"    e.g. "AAPL"
 *   Crypto → "{SYMBOL}"    e.g. "BTC"
 */

// Load .env.local for local runs (GitHub Actions injects env vars directly)
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";

// Import schema directly — avoids pulling in Next.js-specific lib/env validation
import { tickers } from "@/lib/db/schema/tickers";
import type { NewTicker } from "@/lib/db/schema/tickers";

// ─── DB ───────────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env["DATABASE_URL"];
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not set");
  process.exit(1);
}

// Standalone connection — no shared client to avoid Next.js env validation
const pg = postgres(DATABASE_URL, { max: 1, prepare: false });
const db = drizzle(pg);

// ─── Fetch utilities ──────────────────────────────────────────────────────────

async function fetchJson<T>(url: string, label: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.warn(`[${label}] HTTP ${res.status} — skipping`);
      return null;
    }
    const data = await res.json() as T;
    return data;
  } catch (err) {
    console.warn(`[${label}] fetch failed: ${String(err)} — skipping`);
    return null;
  }
}

// ─── TWSE ─────────────────────────────────────────────────────────────────────

interface TwseRow {
  Code: string;
  Name: string;
  [k: string]: unknown;
}

async function fetchTwse(): Promise<NewTicker[]> {
  const data = await fetchJson<TwseRow[]>(
    "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL",
    "TWSE"
  );
  if (!data || !Array.isArray(data) || data.length === 0) {
    console.warn("[TWSE] Empty response — market closed or API unavailable");
    return [];
  }

  const rows: NewTicker[] = [];
  for (const s of data) {
    if (!s.Code || !s.Name) continue;
    // Skip fund codes that look like ETF sub-products (contain "-")
    if (s.Code.includes("-")) continue;
    rows.push({
      symbol: `${s.Code}.TW`,
      name: s.Name.trim(),
      exchange: "TWSE",
      lastUpdated: new Date(),
    });
  }

  console.log(`[TWSE] ${rows.length} stocks`);
  return rows;
}

// ─── TPEx ─────────────────────────────────────────────────────────────────────

interface TpexRow {
  SecuritiesCompanyCode?: string;
  CompanyName?: string;
  companyCh?: string; // alternate field name seen in some response versions
  [k: string]: unknown;
}

async function fetchTpex(): Promise<NewTicker[]> {
  const data = await fetchJson<TpexRow[]>(
    "https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes",
    "TPEx"
  );
  if (!data || !Array.isArray(data) || data.length === 0) {
    console.warn("[TPEx] Empty response — market closed or API unavailable");
    return [];
  }

  const rows: NewTicker[] = [];
  for (const s of data) {
    const code = s.SecuritiesCompanyCode;
    if (!code) continue;
    const name = (s.CompanyName ?? s.companyCh ?? code).trim();
    rows.push({
      symbol: `${code}.TWO`,
      name,
      exchange: "TPEx",
      lastUpdated: new Date(),
    });
  }

  console.log(`[TPEx] ${rows.length} stocks`);
  return rows;
}

// ─── Crypto (CoinGecko free tier) ─────────────────────────────────────────────

interface CoinGeckoRow {
  symbol: string;
  name: string;
}

async function fetchCrypto(): Promise<NewTicker[]> {
  const data = await fetchJson<CoinGeckoRow[]>(
    "https://api.coingecko.com/api/v3/coins/markets" +
      "?vs_currency=usd&order=market_cap_desc&per_page=50&page=1",
    "CoinGecko"
  );
  if (!data || !Array.isArray(data)) return [];

  const rows = data.map<NewTicker>((c) => ({
    symbol: c.symbol.toUpperCase(),
    name: c.name,
    exchange: "CRYPTO",
    lastUpdated: new Date(),
  }));

  console.log(`[CoinGecko] ${rows.length} coins`);
  return rows;
}

// ─── US Mega-cap static list ──────────────────────────────────────────────────
// Updated manually when needed. Covers the most-mentioned US stocks in trading
// tips. NYSE-listed stocks use exchange "NYSE"; NASDAQ ones use "NASDAQ".

const US_STOCKS: NewTicker[] = [
  { symbol: "AAPL",  name: "Apple Inc.",                 exchange: "NASDAQ", lastUpdated: new Date() },
  { symbol: "MSFT",  name: "Microsoft Corporation",      exchange: "NASDAQ", lastUpdated: new Date() },
  { symbol: "NVDA",  name: "NVIDIA Corporation",         exchange: "NASDAQ", lastUpdated: new Date() },
  { symbol: "AMZN",  name: "Amazon.com Inc.",            exchange: "NASDAQ", lastUpdated: new Date() },
  { symbol: "GOOGL", name: "Alphabet Inc. Class A",      exchange: "NASDAQ", lastUpdated: new Date() },
  { symbol: "GOOG",  name: "Alphabet Inc. Class C",      exchange: "NASDAQ", lastUpdated: new Date() },
  { symbol: "META",  name: "Meta Platforms Inc.",        exchange: "NASDAQ", lastUpdated: new Date() },
  { symbol: "TSLA",  name: "Tesla Inc.",                 exchange: "NASDAQ", lastUpdated: new Date() },
  { symbol: "AVGO",  name: "Broadcom Inc.",              exchange: "NASDAQ", lastUpdated: new Date() },
  { symbol: "TSM",   name: "Taiwan Semiconductor ADR",   exchange: "NYSE",   lastUpdated: new Date() },
  { symbol: "AMD",   name: "Advanced Micro Devices",     exchange: "NASDAQ", lastUpdated: new Date() },
  { symbol: "INTC",  name: "Intel Corporation",          exchange: "NASDAQ", lastUpdated: new Date() },
  { symbol: "QCOM",  name: "Qualcomm Inc.",              exchange: "NASDAQ", lastUpdated: new Date() },
  { symbol: "ARM",   name: "Arm Holdings plc",           exchange: "NASDAQ", lastUpdated: new Date() },
  { symbol: "NFLX",  name: "Netflix Inc.",               exchange: "NASDAQ", lastUpdated: new Date() },
  { symbol: "ORCL",  name: "Oracle Corporation",         exchange: "NYSE",   lastUpdated: new Date() },
  { symbol: "CRM",   name: "Salesforce Inc.",            exchange: "NYSE",   lastUpdated: new Date() },
  { symbol: "ADBE",  name: "Adobe Inc.",                 exchange: "NASDAQ", lastUpdated: new Date() },
  { symbol: "MU",    name: "Micron Technology Inc.",     exchange: "NASDAQ", lastUpdated: new Date() },
  { symbol: "AMAT",  name: "Applied Materials Inc.",     exchange: "NASDAQ", lastUpdated: new Date() },
  { symbol: "LRCX",  name: "Lam Research Corporation",  exchange: "NASDAQ", lastUpdated: new Date() },
  { symbol: "KLAC",  name: "KLA Corporation",            exchange: "NASDAQ", lastUpdated: new Date() },
  { symbol: "ASML",  name: "ASML Holding N.V.",          exchange: "NASDAQ", lastUpdated: new Date() },
  { symbol: "JPM",   name: "JPMorgan Chase & Co.",       exchange: "NYSE",   lastUpdated: new Date() },
  { symbol: "BRK.B", name: "Berkshire Hathaway Class B", exchange: "NYSE",   lastUpdated: new Date() },
  { symbol: "V",     name: "Visa Inc.",                  exchange: "NYSE",   lastUpdated: new Date() },
  { symbol: "MA",    name: "Mastercard Inc.",            exchange: "NYSE",   lastUpdated: new Date() },
  { symbol: "WMT",   name: "Walmart Inc.",               exchange: "NYSE",   lastUpdated: new Date() },
  { symbol: "COST",  name: "Costco Wholesale Corporation",exchange:"NASDAQ",  lastUpdated: new Date() },
  { symbol: "SPY",   name: "SPDR S&P 500 ETF",           exchange: "NYSE",   lastUpdated: new Date() },
  { symbol: "QQQ",   name: "Invesco QQQ ETF",            exchange: "NASDAQ", lastUpdated: new Date() },
];

// ─── Upsert ───────────────────────────────────────────────────────────────────

async function upsertAll(rows: NewTicker[]): Promise<void> {
  if (rows.length === 0) return;

  // Batch in chunks of 500 to stay under Postgres parameter limits
  const CHUNK_SIZE = 500;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    await db
      .insert(tickers)
      .values(chunk)
      .onConflictDoUpdate({
        target: tickers.symbol,
        set: {
          // Refresh name + lastUpdated; leave aliases, delistedAt, createdAt untouched
          name: sql`EXCLUDED.name`,
          lastUpdated: sql`now()`,
        },
      });
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══ T4 Ticker Sync started ═══");
  const startMs = Date.now();

  // Fetch all sources concurrently
  const [twse, tpex, crypto] = await Promise.all([
    fetchTwse(),
    fetchTpex(),
    fetchCrypto(),
  ]);

  const us = US_STOCKS;
  console.log(`[US static] ${us.length} stocks`);

  const all = [...twse, ...tpex, ...us, ...crypto];
  console.log(`Total: ${all.length} rows to upsert`);

  if (all.length === 0) {
    console.warn("All sources failed or returned empty — skipping DB write.");
    await pg.end();
    process.exit(0);
  }

  await upsertAll(all);

  const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`═══ Done in ${elapsedSec}s ═══`);
  await pg.end();
}

main().catch((err) => {
  console.error("Sync failed:", err);
  process.exit(1);
});
