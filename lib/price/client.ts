/**
 * Price Data Client — market-aware (TW + US).
 *
 * TW:
 *   1. FinMind (primary) — token-gated, ~15 min delay
 *   2. Yahoo Finance (fallback) — unofficial
 * US:
 *   1. Finnhub /quote — token-gated, real-time
 *   2. Yahoo Finance (fallback)
 *
 * Every public function returns null on any error — never throws.
 */

import { fetchLatestPrice, fetchLatestQuote as fetchTwQuote, type LatestQuote } from "@/lib/finmind/client";
import { fetchYahooPrice } from "@/lib/price/yahoo-fallback";
import { fetchUsQuote } from "@/lib/finnhub/client";
import { classifyMarket } from "@/lib/ticker/classify";

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch the current (or most recent) price for a stock ticker.
 *
 * Dispatches by market:
 *   - TW symbol → FinMind primary, Yahoo fallback
 *   - US symbol → Finnhub primary, Yahoo fallback
 *
 * @param symbol - Resolved symbol, e.g. "2330.TW", "AAPL", bare "2330"
 * @returns Price as a number, or null if all sources fail
 */
export async function fetchCurrentPrice(
  symbol: string | null | undefined
): Promise<number | null> {
  if (!symbol) return null;

  const market = classifyMarket(symbol);

  if (market === "US") {
    const fh = await fetchUsQuote(symbol);
    if (fh && fh.close > 0) return fh.close;
    return fetchYahooPrice(symbol);
  }

  // ── TW (default) ──────────────────────────────────────────────────────────
  const finmindPrice = await fetchLatestPrice(symbol);
  if (finmindPrice !== null) return finmindPrice;

  // Auto-suffix bare Taiwan codes for Yahoo (needs ".TW" or ".TWO")
  const yahooSymbol = /^\d{4,6}$/.test(symbol) ? `${symbol}.TW` : symbol;
  return fetchYahooPrice(yahooSymbol);
}

/**
 * Fetch latest OHLCV + day-over-day change for a stock ticker.
 * Market-aware; returns the same shape for both TW and US.
 */
export async function fetchLatestQuote(
  symbol: string
): Promise<LatestQuote | null> {
  const market = classifyMarket(symbol);

  if (market === "US") {
    const us = await fetchUsQuote(symbol);
    if (!us) return null;
    return {
      date: us.date,
      close: us.close,
      open: us.open,
      high: us.high,
      low: us.low,
      volume: us.volume,
      prevClose: us.prevClose,
      changeAbs: us.changeAbs,
      changePct: us.changePct,
    };
  }

  return fetchTwQuote(symbol);
}
