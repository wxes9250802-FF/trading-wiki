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

// ─── OHLCV (for intraday alerts on US symbols) ────────────────────────────────

interface YahooOhlcvIndicators {
  quote?: Array<{
    open?: (number | null)[];
    high?: (number | null)[];
    low?: (number | null)[];
    close?: (number | null)[];
    volume?: (number | null)[];
  }>;
}

interface YahooChartResultFull {
  timestamp?: number[];
  indicators?: YahooOhlcvIndicators;
}

interface YahooChartFullResponse {
  chart?: {
    result?: YahooChartResultFull[];
    error?: { code: string; description: string } | null;
  };
}

export interface OhlcvRow {
  date: string;     // "YYYY-MM-DD" (UTC date of the trading session)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Fetch daily OHLCV bars from Yahoo. Defaults to 1 month range.
 * Returns null on error, [] when there's no data.
 */
export async function fetchYahooOhlcv(
  symbol: string,
  range: "5d" | "1mo" | "3mo" = "1mo"
): Promise<OhlcvRow[] | null> {
  const url = `${YF_BASE}/${encodeURIComponent(symbol)}?interval=1d&range=${range}`;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; TradingWiki/1.0)",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as YahooChartFullResponse;
    if (data.chart?.error) return null;

    const result = data.chart?.result?.[0];
    const ts = result?.timestamp ?? [];
    const q = result?.indicators?.quote?.[0];
    if (!q || ts.length === 0) return [];

    const rows: OhlcvRow[] = [];
    for (let i = 0; i < ts.length; i++) {
      const open = q.open?.[i];
      const high = q.high?.[i];
      const low = q.low?.[i];
      const close = q.close?.[i];
      const volume = q.volume?.[i];
      if (
        typeof open !== "number" ||
        typeof high !== "number" ||
        typeof low !== "number" ||
        typeof close !== "number" ||
        typeof volume !== "number"
      ) continue;
      rows.push({
        date: new Date(ts[i]! * 1000).toISOString().slice(0, 10),
        open,
        high,
        low,
        close,
        volume,
      });
    }
    return rows;
  } catch {
    return null;
  }
}
