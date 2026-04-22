/**
 * Price Data Client — Taiwan stocks only
 *
 * Fetches the current market price for a Taiwan stock ticker.
 * Used by:
 *   - classify-messages worker (set price_at_tip when tip is created)
 *   - verify-tips worker        (fetch price_at_check for target monitoring)
 *
 * Primary source:  FinMind API (requires FINMIND_TOKEN, ~15 min delay)
 * Fallback source: Yahoo Finance chart API (unofficial, no key required)
 *
 * Design: every public function returns null on any error — never throws.
 */

import { fetchLatestPrice } from "@/lib/finmind/client";
import { fetchYahooPrice } from "@/lib/price/yahoo-fallback";

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch the current (or most recent) price for a Taiwan stock ticker.
 *
 * Resolution order:
 *   1. FinMind (primary) — stable, token-gated, ~15 min delay
 *   2. Yahoo Finance (fallback) — unofficial, no key, may be unreliable
 *
 * @param symbol - Resolved symbol, e.g. "2330.TW", "6451.TWO", or bare "2330".
 *                 Bare numeric codes are auto-suffixed with ".TW" for Yahoo fallback.
 * @returns Price as a number, or null if both sources fail
 */
export async function fetchCurrentPrice(
  symbol: string | null | undefined
): Promise<number | null> {
  if (!symbol) return null;

  // ── Primary: FinMind ──────────────────────────────────────────────────────
  const finmindPrice = await fetchLatestPrice(symbol);
  if (finmindPrice !== null) return finmindPrice;

  // ── Fallback: Yahoo Finance ───────────────────────────────────────────────
  // Auto-suffix bare Taiwan codes for Yahoo (needs ".TW" or ".TWO")
  const yahooSymbol = /^\d{4,6}$/.test(symbol) ? `${symbol}.TW` : symbol;
  return fetchYahooPrice(yahooSymbol);
}
