/**
 * T11 — Price Data Client
 *
 * Fetches the current market price for a ticker symbol.
 * Used by:
 *   - T6 classify-messages worker (set price_at_tip when tip is created)
 *   - T11 verify-tips worker      (fetch price_at_check for verification)
 *
 * Markets:
 *   TW / US → Yahoo Finance chart API (unofficial, no API key required)
 *   CRYPTO  → CoinGecko simple/price  (free tier, no API key required)
 *
 * Design: every public function returns null on any error — never throws.
 * Callers treat null as "price unavailable, skip verification setup".
 */

// ─── Yahoo Finance ─────────────────────────────────────────────────────────────

const YF_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

// ─── CoinGecko ─────────────────────────────────────────────────────────────────

const CG_PRICE = "https://api.coingecko.com/api/v3/simple/price";

/**
 * Maps our stored crypto symbol (uppercase, e.g. "BTC") to the CoinGecko
 * coin ID used in REST calls (e.g. "bitcoin").
 * Covers CoinGecko top-50 as synced by T4 sync-tickers.ts.
 */
const CG_ID: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  USDT: "tether",
  BNB: "binancecoin",
  SOL: "solana",
  USDC: "usd-coin",
  XRP: "ripple",
  DOGE: "dogecoin",
  TON: "the-open-network",
  ADA: "cardano",
  TRX: "tron",
  AVAX: "avalanche-2",
  SHIB: "shiba-inu",
  DOT: "polkadot",
  LINK: "chainlink",
  MATIC: "matic-network",
  NEAR: "near",
  LTC: "litecoin",
  BCH: "bitcoin-cash",
  UNI: "uniswap",
  ATOM: "cosmos",
  XLM: "stellar",
  OP: "optimism",
  ARB: "arbitrum",
  APT: "aptos",
  ICP: "internet-computer",
  FIL: "filecoin",
  HBAR: "hedera-hashgraph",
  CRO: "crypto-com-chain",
  VET: "vechain",
};

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch the current (or most recent) price for a ticker.
 *
 * @param symbol - The resolved ticker symbol stored in the `tips` table
 *                 (e.g. "2330.TW", "AAPL", "BTC")
 * @param market - Which exchange family to route to
 * @returns Price as a number, or null if unavailable
 */
export async function fetchCurrentPrice(
  symbol: string | null | undefined,
  market: "TW" | "US" | "CRYPTO"
): Promise<number | null> {
  if (!symbol) return null;

  try {
    if (market === "CRYPTO") {
      return await fetchCryptoPrice(symbol);
    }
    // Both TW (e.g. "2330.TW") and US (e.g. "AAPL") symbols work with Yahoo
    return await fetchYahooPrice(symbol);
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

// ─── CoinGecko implementation ─────────────────────────────────────────────────

async function fetchCryptoPrice(symbol: string): Promise<number | null> {
  const upper = symbol.toUpperCase();
  const coinId = CG_ID[upper];

  if (coinId) {
    const url = `${CG_PRICE}?ids=${coinId}&vs_currencies=usd`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as Record<string, { usd?: number }>;
    const price = data[coinId]?.usd;
    return typeof price === "number" && price > 0 ? price : null;
  }

  // Unknown crypto symbol — try Yahoo Finance with -USD suffix as fallback
  // Works for newer coins not in the map (e.g. "PEPE-USD", "WIF-USD")
  return fetchYahooPrice(`${upper}-USD`);
}
