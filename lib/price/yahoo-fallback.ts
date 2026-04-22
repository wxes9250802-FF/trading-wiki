/**
 * Yahoo Finance fallback price client.
 *
 * Used only when the primary FinMind source returns null (e.g. quota exceeded,
 * off-hours, or token not configured).  Unofficial API — no key required but
 * may be rate-limited or blocked without notice.
 */

const YF_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

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

/**
 * Fetch price via Yahoo Finance chart API.
 * Returns null on any error — never throws.
 *
 * @param symbol - Full Yahoo symbol, e.g. "2330.TW" or "6451.TWO"
 */
export async function fetchYahooPrice(symbol: string): Promise<number | null> {
  const url = `${YF_BASE}/${encodeURIComponent(symbol)}?interval=1d&range=1d`;

  try {
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
  } catch {
    return null;
  }
}
