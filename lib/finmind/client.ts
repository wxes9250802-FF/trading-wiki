/**
 * FinMind API Client — Taiwan stocks
 *
 * Official data source for Taiwan stock prices and fundamentals.
 * Requires FINMIND_TOKEN env var (free tier: 300 req/hour, ~15 min delay).
 *
 * Base URL: https://api.finmindtrade.com/api/v4/data
 *
 * Design: every public function returns null / null array on any error — never throws.
 */

const FINMIND_BASE = "https://api.finmindtrade.com/api/v4/data";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Strip Yahoo-style suffixes from a Taiwan stock symbol.
 * "2330.TW" → "2330"  |  "6451.TWO" → "6451"  |  "2330" → "2330"
 */
function stripSuffix(symbol: string): string {
  return symbol.replace(/\.(TW|TWO)$/i, "");
}

function getToken(): string | null {
  const token = process.env["FINMIND_TOKEN"];
  if (!token) {
    console.warn("[finmind] FINMIND_TOKEN is not set — skipping FinMind fetch");
    return null;
  }
  return token;
}

// ─── Raw API types ────────────────────────────────────────────────────────────

interface FinMindResponse<T> {
  msg: string;
  status: number;
  data: T[];
}

interface StockInfoRecord {
  industry_category: string;
  stock_id: string;
  stock_name: string;
  type: string; // "twse" | "tpex"
}

interface StockPriceRecord {
  date: string;
  stock_id: string;
  Trading_Volume: number;
  Trading_money: number;
  open: number;
  max: number;
  min: number;
  close: number;
  spread: number;
  Trading_turnover: number;
}

interface InstitutionalRecord {
  date: string;
  stock_id: string;
  buy: number;
  name: string;
  sell: number;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function fetchStockInfo(stockId: string): Promise<{
  stockId: string;
  stockName: string;
  industryCategory: string;
  type: "twse" | "tpex";
} | null> {
  const token = getToken();
  if (!token) return null;

  const id = stripSuffix(stockId);

  try {
    const url = new URL(FINMIND_BASE);
    url.searchParams.set("dataset", "TaiwanStockInfo");
    url.searchParams.set("data_id", id);
    url.searchParams.set("token", token);

    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return null;

    const json = (await res.json()) as FinMindResponse<StockInfoRecord>;
    if (json.status !== 200 || !json.data || json.data.length === 0) return null;

    const record = json.data[0];
    if (!record) return null;

    const type = record.type === "tpex" ? "tpex" : "twse";

    return {
      stockId: record.stock_id,
      stockName: record.stock_name,
      industryCategory: record.industry_category,
      type,
    };
  } catch {
    return null;
  }
}

export async function fetchLatestPrice(stockId: string): Promise<number | null> {
  const token = getToken();
  if (!token) return null;

  const id = stripSuffix(stockId);

  // Look back 7 days to survive weekends, Lunar New Year, and 228-type
  // long holidays. Without this, Monday mornings or post-holiday first-days
  // return empty `data` and force a Yahoo fallback for every call.
  const lookback = new Date();
  lookback.setDate(lookback.getDate() - 7);
  const startDate = lookback.toISOString().slice(0, 10); // "YYYY-MM-DD"

  try {
    const url = new URL(FINMIND_BASE);
    url.searchParams.set("dataset", "TaiwanStockPrice");
    url.searchParams.set("data_id", id);
    url.searchParams.set("start_date", startDate);
    url.searchParams.set("token", token);

    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return null;

    const json = (await res.json()) as FinMindResponse<StockPriceRecord>;
    if (json.status !== 200 || !json.data || json.data.length === 0) return null;

    // Take the last record (most recent trading day)
    const last = json.data[json.data.length - 1];
    if (!last) return null;

    return typeof last.close === "number" && last.close > 0 ? last.close : null;
  } catch {
    return null;
  }
}

/**
 * Fetch daily OHLCV data for a stock from a given start date.
 * Uses TaiwanStockPrice dataset — returns the rows sorted by date ascending.
 * Returns null on network/API failure; returns [] when FinMind has no data
 * for the requested range (e.g., non-trading day).
 */
export async function fetchDailyOHLCV(
  stockId: string,
  startDate: string // "YYYY-MM-DD"
): Promise<Array<{
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}> | null> {
  const token = getToken();
  if (!token) return null;

  const id = stripSuffix(stockId);

  try {
    const url = new URL(FINMIND_BASE);
    url.searchParams.set("dataset", "TaiwanStockPrice");
    url.searchParams.set("data_id", id);
    url.searchParams.set("start_date", startDate);
    url.searchParams.set("token", token);

    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return null;

    const json = (await res.json()) as FinMindResponse<StockPriceRecord>;
    if (json.status !== 200 || !json.data) return null;
    if (json.data.length === 0) return [];

    return json.data.map((r) => ({
      date: r.date,
      open: r.open,
      close: r.close,
      high: r.max,
      low: r.min,
      volume: r.Trading_Volume,
    }));
  } catch {
    return null;
  }
}

/**
 * Fetch institutional investor buy/sell data for a stock.
 * Designed for future T5 use — returns null on any error.
 */
export async function fetchInstitutionalInvestors(
  stockId: string,
  startDate: string // "YYYY-MM-DD"
): Promise<Array<{
  date: string;
  name: "Foreign_Investor" | "Investment_Trust" | "Dealer_self" | "Dealer_Hedging" | "Foreign_Dealer_Self";
  buy: number;
  sell: number;
}> | null> {
  const token = getToken();
  if (!token) return null;

  const id = stripSuffix(stockId);

  try {
    const url = new URL(FINMIND_BASE);
    url.searchParams.set("dataset", "TaiwanStockInstitutionalInvestorsBuySell");
    url.searchParams.set("data_id", id);
    url.searchParams.set("start_date", startDate);
    url.searchParams.set("token", token);

    const res = await fetch(url.toString(), {
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return null;

    const json = (await res.json()) as FinMindResponse<InstitutionalRecord>;
    if (json.status !== 200 || !json.data) return null;
    if (json.data.length === 0) return [];

    const validNames = new Set([
      "Foreign_Investor",
      "Investment_Trust",
      "Dealer_self",
      "Dealer_Hedging",
      "Foreign_Dealer_Self",
    ]);

    return json.data
      .filter((r) => validNames.has(r.name))
      .map((r) => ({
        date: r.date,
        name: r.name as "Foreign_Investor" | "Investment_Trust" | "Dealer_self" | "Dealer_Hedging" | "Foreign_Dealer_Self",
        buy: r.buy,
        sell: r.sell,
      }));
  } catch {
    return null;
  }
}
