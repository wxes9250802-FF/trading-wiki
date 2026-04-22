/**
 * Price Data Client — Taiwan stocks only
 *
 * Fetches the current market price for a Taiwan stock ticker.
 * Used by:
 *   - classify-messages worker (set price_at_tip when tip is created)
 *   - verify-tips worker        (fetch price_at_check for target monitoring)
 *
 * Source: Yahoo Finance chart API (unofficial, no API key required).
 * Will be replaced with broker API once available.
 *
 * Design: every public function returns null on any error — never throws.
 */

const YF_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch the current (or most recent) price for a Taiwan stock ticker.
 *
 * @param symbol - Resolved symbol, e.g. "2330.TW" or "6451.TWO".
 *                 Bare numeric codes (e.g. "2330") are auto-suffixed with ".TW".
 * @returns Price as a number, or null if unavailable
 */
export async function fetchCurrentPrice(
  symbol: string | null | undefined
): Promise<number | null> {
  if (!symbol) return null;

  // Auto-suffix bare Taiwan codes
  const normalised = /^\d{4,6}$/.test(symbol) ? `${symbol}.TW` : symbol;

  try {
    return await fetchYahooPrice(normalised);
  } catch {
    return null;
  }
}

// ─── Yahoo Finance implementation ─────────────────────────────────────────────

interface YahooChartMeta {
  regularMarketPrice?: number;
  previousClose?: number;
  chartPreviousClose?: number;
}

interface YahooChartResponse {
  chart?: {
    result?: Array<{ meta?: YahooChartMeta }>;
    error?: { code: string; description: string } | null;
  };
}

async function fetchYahooPrice(symbol: string): Promise<number | null> {
  const url = `${YF_BASE}/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; TradingWiki/1.0)",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) return null;

  const data = (await res.json()) as YahooChartResponse;
  if (data.chart?.error) return null;

  const meta = data.chart?.result?.[0]?.meta;
  const price =
    meta?.regularMarketPrice ??
    meta?.previousClose ??
    meta?.chartPreviousClose;

  return typeof price === "number" && price > 0 ? price : null;
}
