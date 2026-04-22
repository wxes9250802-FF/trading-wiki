import "server-only";
import { eq, or, and, isNull, ilike, sql } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { tickers } from "@/lib/db/schema/tickers";
import type { Ticker } from "@/lib/db/schema/tickers";

/**
 * T7 — Ticker Resolver
 *
 * Resolves a raw string (from AI output or user input) to a canonical
 * Ticker row in the `tickers` table.
 *
 * Resolution strategies, tried in order:
 *   1. Exact symbol match (case-insensitive)  "aapl" → "AAPL"
 *   2. Taiwan bare code   (4–6 digits)        "2330" → "2330.TW" / "2330.TWO"
 *   3. Exact name match   (case-insensitive)  "台積電" → row with name="台積電"
 *   4. Alias substring    (case-insensitive)  "tsmc" → row with aliases ILIKE '%tsmc%'
 *
 * Returns null if no active ticker matches.
 * Only returns active tickers (delistedAt IS NULL).
 */

// Reusable filter: active tickers only
const isActive = isNull(tickers.delistedAt);

export async function resolveTicker(raw: string): Promise<Ticker | null> {
  const input = raw.trim();
  if (!input) return null;

  // ── Strategy 1: Exact symbol (case-insensitive) ────────────────────────
  // Handles: "AAPL" → "AAPL", "aapl" → "AAPL", "2330.tw" → "2330.TW"
  const [bySymbol] = await db
    .select()
    .from(tickers)
    .where(and(sql`lower(${tickers.symbol}) = ${input.toLowerCase()}`, isActive))
    .limit(1);
  if (bySymbol) return bySymbol;

  // ── Strategy 2: Taiwan bare code ──────────────────────────────────────
  // Handles: "2330" → "2330.TW" (TWSE) or "2330.TWO" (TPEx)
  if (/^\d{4,6}$/.test(input)) {
    const [byTwCode] = await db
      .select()
      .from(tickers)
      .where(
        and(
          or(
            eq(tickers.symbol, `${input}.TW`),
            eq(tickers.symbol, `${input}.TWO`)
          ),
          isActive
        )
      )
      .limit(1);
    if (byTwCode) return byTwCode;
  }

  // ── Strategy 3: Exact name match (case-insensitive) ───────────────────
  // Handles: "台積電" → name="台積電", "apple inc." → name="Apple Inc."
  const [byName] = await db
    .select()
    .from(tickers)
    .where(and(sql`lower(${tickers.name}) = ${input.toLowerCase()}`, isActive))
    .limit(1);
  if (byName) return byName;

  // ── Strategy 4: Alias substring (case-insensitive) ────────────────────
  // Handles: "tsmc" → aliases contains "TSMC", "護國神山" → aliases contains it
  // Note: aliases are stored as comma-separated plain text.
  // ILIKE '%input%' may have false positives for very short inputs (< 3 chars).
  if (input.length >= 2) {
    const [byAlias] = await db
      .select()
      .from(tickers)
      .where(and(ilike(tickers.aliases, `%${input}%`), isActive))
      .limit(1);
    if (byAlias) return byAlias;
  }

  return null;
}

/**
 * Resolves multiple raw symbols. Returns a Map of raw input → Ticker (or null).
 * Queries run sequentially — fast enough for typical tips (1–5 tickers).
 */
export async function resolveTickersBulk(
  rawInputs: string[]
): Promise<Map<string, Ticker | null>> {
  const result = new Map<string, Ticker | null>();
  for (const raw of rawInputs) {
    result.set(raw, await resolveTicker(raw));
  }
  return result;
}
