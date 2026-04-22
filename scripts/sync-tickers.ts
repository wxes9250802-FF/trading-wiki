#!/usr/bin/env bun
/**
 * Ticker Whitelist Sync — Taiwan stocks only
 *
 * Fetches all listed stocks from TWSE (上市) and TPEx (上櫃) OpenAPI
 * and upserts into the `tickers` table.
 *
 * Designed to run as a daily GitHub Actions cron job.
 *
 * Data sources:
 *   TWSE   https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL
 *   TPEx   https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes
 *
 * Symbol conventions:
 *   TWSE   → "{code}.TW"   e.g. "2330.TW"
 *   TPEx   → "{code}.TWO"  e.g. "6547.TWO"
 */

import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";

import { tickers } from "@/lib/db/schema/tickers";
import type { NewTicker } from "@/lib/db/schema/tickers";

// ─── DB ───────────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env["DATABASE_URL"];
if (!DATABASE_URL) {
  console.error("ERROR: DATABASE_URL is not set");
  process.exit(1);
}

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
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[${label}] fetch failed: ${String(err)} — skipping`);
    return null;
  }
}

// ─── TWSE (上市) ─────────────────────────────────────────────────────────────

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
    if (s.Code.includes("-")) continue; // Skip ETF sub-products
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

// ─── TPEx (上櫃) ─────────────────────────────────────────────────────────────

interface TpexRow {
  SecuritiesCompanyCode?: string;
  CompanyName?: string;
  companyCh?: string;
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

// ─── Upsert ───────────────────────────────────────────────────────────────────

async function upsertAll(rows: NewTicker[]): Promise<void> {
  if (rows.length === 0) return;

  const CHUNK_SIZE = 500;
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    await db
      .insert(tickers)
      .values(chunk)
      .onConflictDoUpdate({
        target: tickers.symbol,
        set: {
          name: sql`EXCLUDED.name`,
          lastUpdated: sql`now()`,
        },
      });
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══ Ticker Sync started (TW only) ═══");
  const startMs = Date.now();

  const [twse, tpex] = await Promise.all([fetchTwse(), fetchTpex()]);
  const all = [...twse, ...tpex];
  console.log(`Total: ${all.length} rows to upsert`);

  if (all.length === 0) {
    console.warn("Both sources empty — skipping DB write.");
    await pg.end();
    process.exit(0);
  }

  await upsertAll(all);

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`═══ Done in ${elapsed}s ═══`);
  await pg.end();
}

main().catch((err) => {
  console.error("Sync crashed:", err);
  process.exit(1);
});
