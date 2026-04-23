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

export interface LatestQuote {
  date: string;           // "YYYY-MM-DD"
  close: number;
  open: number;
  high: number;
  low: number;
  volume: number;         // in shares (not 張)
  prevClose: number | null;
  changeAbs: number | null;
  changePct: number | null;
}

/**
 * Fetch the latest trading day's OHLCV plus day-over-day change.
 * Looks back 7 days to survive long weekends/holidays. Returns null on any error.
 */
export async function fetchLatestQuote(stockId: string): Promise<LatestQuote | null> {
  const rows = await fetchDailyOHLCV(
    stockId,
    (() => {
      const d = new Date();
      d.setDate(d.getDate() - 7);
      return d.toISOString().slice(0, 10);
    })()
  );
  if (!rows || rows.length === 0) return null;

  const last = rows[rows.length - 1]!;
  const prev = rows.length >= 2 ? rows[rows.length - 2]! : null;
  const prevClose = prev ? prev.close : null;
  const changeAbs = prevClose !== null ? last.close - prevClose : null;
  const changePct =
    prevClose !== null && prevClose > 0
      ? ((last.close - prevClose) / prevClose) * 100
      : null;

  return {
    date: last.date,
    close: last.close,
    open: last.open,
    high: last.high,
    low: last.low,
    volume: last.volume,
    prevClose,
    changeAbs,
    changePct,
  };
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

// ─── TWSE Watch/Punish List ───────────────────────────────────────────────────

/**
 * Raw record from TWSE /v1/announcement/notice
 * Number "0" with empty Code means "no stocks on the notice list today".
 */
interface TwseNoticeRecord {
  Number: string;
  Code: string;
  Name: string;
  TradingInfoForAttention: string;
  Date: string;      // e.g. "1150416" (Republic of China era YYYMMDD)
  ClosingPrice: string;
  PE: string;
  NumberOfAnnouncement: string;
}

/**
 * Raw record from TWSE /v1/announcement/punish
 */
interface TwsePunishRecord {
  Number: string;
  Code: string;
  Name: string;
  Date: string;      // e.g. "1150416"
  ReasonsOfDisposition: string;
  DispositionMeasures: string; // e.g. "第一次處置"
  DispositionPeriod: string;
  NumberOfAnnouncement: string;
  Detail: string;
  LinkInformation: string;
}

export interface WatchListItem {
  stockId: string;
  stockName: string;
  /** 「注意」「處置」「變更交易方法」等 */
  reason: string;
  /** Announcement date in "YYYY-MM-DD" format */
  date: string;
}

/**
 * Convert a Republic-of-China-era date string (e.g. "1150416") to ISO-8601.
 * ROC year + 1911 = Gregorian year.
 * Returns null if the string cannot be parsed.
 */
function rocDateToIso(roc: string): string | null {
  // Format: YYYMMDD (3-digit year) or possibly YYMMDD
  const clean = roc.trim();
  if (clean.length < 7) return null;

  // Last 4 chars are MMDD, leading part is year
  const mmdd = clean.slice(-4);
  const yearPart = clean.slice(0, clean.length - 4);
  const rocYear = parseInt(yearPart, 10);
  if (isNaN(rocYear)) return null;

  const gregorianYear = rocYear + 1911;
  const mm = mmdd.slice(0, 2);
  const dd = mmdd.slice(2, 4);
  return `${gregorianYear}-${mm}-${dd}`;
}

/**
 * Fetches the current notice and punishment stock lists from TWSE.
 * Uses two free, keyless TWSE OpenAPI endpoints:
 *   - https://openapi.twse.com.tw/v1/announcement/notice   (注意股)
 *   - https://openapi.twse.com.tw/v1/announcement/punish   (處置股)
 *
 * Returns the combined list, deduped by stockId (punish overrides notice).
 * Returns null only if BOTH endpoints fail; returns [] on a non-watch day.
 */
export async function fetchWatchList(): Promise<WatchListItem[] | null> {
  const NOTICE_URL = "https://openapi.twse.com.tw/v1/announcement/notice";
  const PUNISH_URL = "https://openapi.twse.com.tw/v1/announcement/punish";

  let noticeItems: WatchListItem[] = [];
  let punishItems: WatchListItem[] = [];
  let noticeOk = false;
  let punishOk = false;

  // ── Notice stocks ──────────────────────────────────────────────────────────
  try {
    const res = await fetch(NOTICE_URL, { signal: AbortSignal.timeout(15_000) });
    if (res.ok) {
      const data = (await res.json()) as TwseNoticeRecord[];
      noticeOk = true;
      noticeItems = data
        .filter((r) => r.Code && r.Code.trim() !== "")
        .map((r) => ({
          stockId: r.Code.trim(),
          stockName: r.Name.trim(),
          reason: r.TradingInfoForAttention?.trim() || "注意",
          date: rocDateToIso(r.Date) ?? r.Date,
        }));
    }
  } catch {
    console.warn("[watchlist] TWSE notice endpoint failed");
  }

  // ── Punish stocks ──────────────────────────────────────────────────────────
  try {
    const res = await fetch(PUNISH_URL, { signal: AbortSignal.timeout(15_000) });
    if (res.ok) {
      const data = (await res.json()) as TwsePunishRecord[];
      punishOk = true;
      punishItems = data
        .filter((r) => r.Code && r.Code.trim() !== "")
        .map((r) => ({
          stockId: r.Code.trim(),
          stockName: r.Name.trim(),
          reason: r.DispositionMeasures?.trim() || "處置",
          date: rocDateToIso(r.Date) ?? r.Date,
        }));
    }
  } catch {
    console.warn("[watchlist] TWSE punish endpoint failed");
  }

  if (!noticeOk && !punishOk) return null;

  // Merge: punish takes precedence over notice for the same stockId
  const map = new Map<string, WatchListItem>();
  for (const item of noticeItems) map.set(item.stockId, item);
  for (const item of punishItems) map.set(item.stockId, item); // overwrite

  return Array.from(map.values());
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
